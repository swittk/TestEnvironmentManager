// Special thanks to https://gist.github.com/bishil06/6c3a060b33f551ee9acc03188f964dcc
import fs from "fs";
import crypto from "crypto";

/**
 * Computes the MD5 hash of a file specified by its path.
 */
export function createMD5(filePath: fs.PathLike): Promise<string> {
  return new Promise<string>((res, rej) => {
    const hash = crypto.createHash('md5');

    const rStream = fs.createReadStream(filePath);
    rStream.on('data', (data) => {
      hash.update(data);
    });
    rStream.on('end', () => {
      res(hash.digest('hex'));
    });
    rStream.on('error', (err) => {
      rej(err);
    })
  })
}