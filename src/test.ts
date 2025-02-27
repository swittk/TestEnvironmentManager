import { TestEnvironmentConfig } from "./config";
import fs from 'fs';
import { createMD5 } from "./createMD5";
import NodeFormData from 'form-data';
import { EphemeralUpload } from "./EphemeralUploadManager";
import path from "path";
import nodefetch from 'node-fetch';


const dockerMongoInitScript = {
  filePath: './mongo-init/init-db.sh',
  fileData: `#!/bin/bash
set -e

# Initialize MongoDB if database is empty
if [ -z "$(ls -A /data/db 2>/dev/null | grep -v 'lost+found')" ] || [ ! -f "/data/db/.initialized" ]; then
  echo "Database appears to be empty, checking for dump files..."
  
  # Find any .dump or archive files in the /dump directory
  # DUMP_FILE=$(find /dump -type f -name "*.dump" -o -name "db.dump" -o -name "*.archive" | head -n 1)
  DUMP_FILE=$(ls /dump/*.dump /dump/db.dump /dump/*.archive 2>/dev/null | head -n 1)

  if [ -n "$DUMP_FILE" ]; then
    echo "Found dump file: $DUMP_FILE"
    echo "Restoring database from archive dump..."
    
    # Restore from the archive dump - this works for both named and unnamed databases
    mongorestore --archive=$DUMP_FILE
    
    # Mark as initialized to prevent running again
    touch /data/db/.initialized
    echo "Database restore completed successfully."
  else
    echo "No MongoDB dump archives found in /dump directory. Starting with empty database."
    touch /data/db/.initialized
  fi
else
  echo "Database already contains data, skipping restore."
fi`
}

async function test() {
  const config: TestEnvironmentConfig = {
    git: {
      repoUrl: "https://github.com/foggyhazel/shinebright",
      defaultBranch: "queues",
      auth: {
        sshKeyPath: "~/.ssh/id_rsa"
      }
    },
    docker: {
      dockerCompose: {
        composeFile: "./docker-compose-backend.yml",
        envFileData:
          `MONGO_INIT_SOURCE="./mongo-init/"
MONGO_DUMP_SOURCE="./mongo-dump/"`
      },
    },
    environment: {
      port: [{
        name: 'backend',
        internalPort: 1337,
      }],
    },
    additionalFiles: {
      [dockerMongoInitScript.filePath]: {
        content: dockerMongoInitScript.fileData,
        mode: '755'
      }
    }
  }
  // const fileStream = new FormData();
  // const fileStream = fs.createReadStream('filePath');
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 900000); // 15 minutes

  const API_BASE_URL = process.env.API_BASE_URL;
  if (!API_BASE_URL) {
    throw "No API URL";
  }
  try {
    const fileToUpload = path.resolve('./src/dump2025.dump');

    const md5 = await createMD5(fileToUpload);
    type TryUploadBodyType = {
      md5: string, fileName?: string, fileSize?: number
    }
    type TryUploadReplyType = {
      /** If the file already exists (in that case pls don't reupload) */
      exists: boolean,
      /** The token to use as a referral to the upload (if exists is false and needs reupload) */
      token: string
    };
    const tryUploadBody: TryUploadBodyType = {
      md5
    }
    console.log('about to check upload', fileToUpload, 'with md5', md5);
    const tryUpload: TryUploadReplyType = await (await fetch(`${API_BASE_URL}/uploads/initiate`, {
      method: 'POST',
      headers: {
        'Content-type': "application/json"
      },
      body: JSON.stringify(tryUploadBody)
    })).json();
    if (!tryUpload.exists) {
      console.log('file', fileToUpload, 'never existed; will upload');
      // If file never existed, we upload it.

      // The `uploads/:token` endpoint expects a multipart form data body with the field of `file` containing
      // the binary file to upload
      const formData = new NodeFormData();
      const fileStream = fs.createReadStream(fileToUpload);

      // Node's form-data supports read streams :D
      formData.append('file',
        fileStream
      );
      const uploadResText = await (await nodefetch(`${API_BASE_URL}/uploads/${tryUpload.token}`, {
        method: 'POST',
        body: formData,
        headers: formData.getHeaders()
      })).text();
      console.log('uploadRes is', uploadResText)
      const uploadRes = JSON.parse(uploadResText) as EphemeralUpload | { error: string };
      if ('error' in uploadRes) {
        console.log('file', fileToUpload, 'failed to upload');
        throw uploadRes.error;
      }
      console.log('file', fileToUpload, 'uploaded successfully');
      // Upload done yay.
    }
    else {
      console.log('file', fileToUpload, 'already exists');
    }
    config.additionalFiles!['./mongo-dump/db.dump'] = {
      // content?: string; // The file content as a string (plain text or base64 encoded)
      // encoding?: 'utf8' | 'base64';
      checksum: md5 // the md5 checksum of the file (used when we upload it prior to this)
    }

    const res = await fetch(`${API_BASE_URL}/environments`, {
      method: 'POST',
      headers: {
        'Content-type': "application/json"
      },
      // body: fileStream
      body: JSON.stringify({
        config,
        branch: "queues",
      }),
      signal: controller.signal
    })
    const restext = await res.text();
    console.log('spun up results', restext)
    clearTimeout(timeoutId);
  } catch (e) {
    clearTimeout(timeoutId);
    throw e;
  }
}
test();
