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
      containerPort: 1337
    }
  }
  const res = await fetch('https://testenv.testing.kongdachalert.com/environments', {
    method: 'POST',
    headers: {
      'Content-type': "application/json"
    },
    body: JSON.stringify({
      config,
      branch: "prescriptionstuff",
    })
  })
  console.log('spun up results', await res.json())
}
test();