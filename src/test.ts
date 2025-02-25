import { TestEnvironmentConfig } from "./config";
import fs from 'fs';
import { createMD5 } from "./createMD5";
import NodeFormData from 'form-data';
import { EphemeralUpload } from "./EphemeralUploadManager";

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
      }
    },
    environment: {
      port: [{
        name: 'backend',
        internalPort: 1337,
      }]
    }
  }
  // const fileStream = new FormData();
  // const fileStream = fs.createReadStream('filePath');
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 900000); // 15 minutes

  const API_BASE_URL = process.env.API_BASE_URL;
  if (!API_BASE_URL) throw "No API URL";
  try {
    const fileToUpload = 'myfile.txt';

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
    const tryUpload: TryUploadReplyType = await (await fetch(`${API_BASE_URL}/uploads/initiate`, {
      method: 'POST',
      headers: {
        'Content-type': "application/json"
      },
      body: JSON.stringify(tryUploadBody)
    })).json();
    if (!tryUpload.exists) {
      // If file never existed, we upload it.

      // The `uploads/:token` endpoint expects a multipart form data body with the field of `file` containing
      // the binary file to upload
      const formData = new NodeFormData();
      const fileStream = fs.createReadStream(fileToUpload);

      // Node's form-data supports read streams :D
      formData.append('file',
        fileStream
      );
      const uploadRes: EphemeralUpload | { error: string } = await (await fetch(`${API_BASE_URL}/uploads/${tryUpload.token}`, {
        method: 'POST',
        body: formData as any as BodyInit,
        headers: formData.getHeaders()
      })).json()
      if ('error' in uploadRes) {
        throw uploadRes.error;
      }
      // Upload done yay.
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
  }
}
test();