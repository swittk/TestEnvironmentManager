import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { Readable, Transform as TransformStream } from 'stream';
import { pipeline } from 'stream/promises';

export interface EphemeralUpload {
  md5: string;
  token: string;
  filePath?: string;
  fileName?: string;
  createdAt: Date;
  lastAccessed: Date;
  fileSize?: number
}

export class EphemeralUploadManager {
  private uploads: Map<string, EphemeralUpload> = new Map();
  private uploadTokens: Map<string, EphemeralUpload> = new Map();
  private uploadsDir: string;

  private EXPIRATION_MS: number = 3600000;
  private cleanupInterval: ReturnType<typeof setInterval>;

  constructor() {
    this.uploadsDir = path.join(os.tmpdir(), 'uploads');
    fs.mkdirSync(this.uploadsDir, { recursive: true });

    // Periodically purge expired uploads.
    this.cleanupInterval = setInterval(() => this.purgeExpiredUploads(), 60000);

    // Register cleanup hooks on exit signals
    process.on('exit', () => this.cleanup());
    process.on('SIGINT', () => {
      this.cleanup();
      process.exit();
    });
    process.on('SIGTERM', () => {
      this.cleanup();
      process.exit();
    });
  }

  public initiateUpload(md5: string, fileName?: string, fileSize?: number): { exists: boolean, token: string } {
    const now = new Date();
    // Check if a file with this MD5 is already cached
    const existing = this.uploads.get(md5);
    if (existing) {
      // If it's still in uploadTokens, then it's not been used for uploading yet!
      if (this.uploadTokens.has(existing.token)) {
        return { exists: false, token: existing.token };
      }
      else {
        return { exists: true, token: existing.token };
      }
    }
    // Generate new token and add entry
    const token = uuidv4();
    const newUpload: EphemeralUpload = { md5, token, fileName, fileSize, createdAt: now, lastAccessed: now };
    this.uploads.set(md5, newUpload);
    this.uploadTokens.set(token, newUpload);
    return { exists: false, token };
  }

  public async handleFileUploadBase64(token: string, base64Data: string): Promise<EphemeralUpload> {
    const uploadEntry = this.uploadTokens.get(token);
    if (!uploadEntry) {
      throw new Error('Invalid upload token');
    }

    const fileBuffer = Buffer.from(base64Data, 'base64');
    const computedMD5 = crypto.createHash('md5').update(fileBuffer).digest('hex');
    if (computedMD5 !== uploadEntry.md5) {
      throw new Error('MD5 mismatch');
    }

    // Use provided fileName or fallback to token
    const fileName = uploadEntry.fileName || token;
    const filePath = path.join(this.uploadsDir, fileName);
    await fs.promises.writeFile(filePath, fileBuffer);
    uploadEntry.filePath = filePath;
    uploadEntry.fileSize = fs.statSync(filePath).size;
    uploadEntry.lastAccessed = new Date();
    this.uploads.set(computedMD5, uploadEntry);
    // Once the file is uploaded, remove the temporary token.
    this.uploadTokens.delete(token);
    return uploadEntry;
  }

  public async handleFileUpload(token: string, fileStream: NodeJS.ReadableStream): Promise<EphemeralUpload> {
    const uploadEntry = this.uploadTokens.get(token);
    if (!uploadEntry) {
      throw new Error('Invalid upload token');
    }

    // Use provided fileName or fallback to token
    const fileName = uploadEntry.fileName || token;
    const filePath = path.join(this.uploadsDir, fileName);

    // Create a write stream for the destination file
    const fileWriteStream = fs.createWriteStream(filePath);

    // Create an MD5 hash stream to verify the file's integrity
    const md5HashStream = crypto.createHash('md5');

    // Set up pipeline to handle the upload and calculate MD5 simultaneously
    try {
      const transformStream = new TransformStreamWithHash(md5HashStream);

      // Run the pipeline
      await pipeline(
        fileStream,
        transformStream,
        fileWriteStream
      );

      // Get the calculated MD5 hash
      const computedMD5 = md5HashStream.digest('hex');

      // Verify MD5 matches what was provided
      if (computedMD5 !== uploadEntry.md5) {
        // If MD5 doesn't match, delete the file and throw error
        fs.unlinkSync(filePath);
        throw new Error('MD5 mismatch');
      }

      // Update the upload entry with file path and last accessed time
      uploadEntry.filePath = filePath;
      uploadEntry.lastAccessed = new Date();
      // Update the file size
      uploadEntry.fileSize = fs.statSync(filePath).size;


      // Once the file is uploaded, remove the temporary token
      this.uploadTokens.delete(token);

      return uploadEntry;
    } catch (error) {
      // Clean up on error
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
      throw error;
    }
  }
  // Publicly access the upload data via MD5. Also updates lastAccessed.
  public getUpload(md5: string): EphemeralUpload | undefined {
    const upload = this.uploads.get(md5);
    if (upload) {
      upload.lastAccessed = new Date();
    }
    return upload;
  }

  // Cleanup all uploaded ephemeral files
  public cleanup(): void {
    for (const upload of this.uploads.values()) {
      if (upload.filePath && fs.existsSync(upload.filePath)) {
        try {
          fs.unlinkSync(upload.filePath);
        } catch (err) {
          console.error(`Failed to delete ephemeral file ${upload.filePath}:`, err);
        }
      }
    }
    try {
      fs.rmdirSync(this.uploadsDir);
    } catch (err) {
      console.error(`Failed to remove uploads directory ${this.uploadsDir}:`, err);
    }
    this.uploads.clear();
  }

  // Purge uploads that haven't been accessed within EXPIRATION_MS.
  public purgeExpiredUploads(): void {
    const now = Date.now();
    for (const [md5, upload] of this.uploads.entries()) {
      if (now - upload.lastAccessed.getTime() > this.EXPIRATION_MS) {
        if (upload.filePath && fs.existsSync(upload.filePath)) {
          try {
            fs.unlinkSync(upload.filePath);
          } catch (err) {
            console.error(`Failed to delete expired file ${upload.filePath}:`, err);
          }
        }
        this.uploads.delete(md5);
      }
    }
  }
}


// Helper class to calculate hash while data passes through
class TransformStreamWithHash extends TransformStream {
  private hashStream: crypto.Hash;

  constructor(hashStream: crypto.Hash) {
    super();
    this.hashStream = hashStream;
  }

  _transform(chunk: any, encoding: string, callback: Function) {
    // Update hash with chunk
    this.hashStream.update(chunk);

    // Pass chunk through unchanged
    this.push(chunk);
    callback();
  }
}