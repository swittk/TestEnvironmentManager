import { TestEnvironmentConfig } from "./config";

async function test() {
  const config: TestEnvironmentConfig = {
    git: {
      repoUrl: "https://github.com/foggyhazel/shinebright",
      defaultBranch: "prescriptionstuff",
      auth: {
        sshKeyPath: "~/.ssh/id_rsa"
      }
    },
    docker: {
      dockerCompose: {
        composeFile: "./docker-compose.yml",
      }
    },
    environment: {
      port: [{
        name: 'backend',
        internalPort: 1337,
      }]
    }
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 900000); // 15 minutes
  try {
    const res = await fetch('https://testenv.testing.kongdachalert.com/environments', {
      method: 'POST',
      headers: {
        'Content-type': "application/json"
      },
      body: JSON.stringify({
        config,
        branch: "prescriptionstuff",
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