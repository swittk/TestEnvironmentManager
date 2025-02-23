// environment-manager.ts
import express from 'express';
import Docker from 'dockerode';
import DockerCompose from 'dockerode-compose';
import { v4 as uuidv4 } from 'uuid';
import { exec } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { TestEnvironmentConfig, defaultConfig as theDefaultConfig, loadConfig } from './config';
import { PortForwardingService } from './port-forwarder';
import { PersistentMap } from './PersistentMap';

function execAsync(cmd: string) {
  return new Promise<string>((resolve, reject) => {
    exec(cmd, (error, stdout, stderr) => {
      if (error) return reject(error)
      // if (stderr) return reject(stderr)
      resolve(stdout)
    })
  })
}


export interface Environment {
  id: string;
  branch: string;
  dbSnapshot?: string;
  port: number;
  status: 'starting' | 'ready' | 'error';
  url: string;
  externalUrl?: string;
  // Track both main container and related containers
  /** 
   * Main container for backwards compatibility
   */
  containerId?: string;
  containers?: {
    mainService: string;
    containers: Array<{
      id: string;
      name: string;
      // service: Docker.ContainerInspectInfo;
    }>;
  };
  isCompose?: boolean;
  composeFile?: string;
  envFile?: string;
  lastAccessed: Date;
  workDir?: string;
}

export class EnvironmentManager {
  public environments: Map<string, Environment> = new PersistentMap();
  private docker = new Docker();
  private defaultConfig: TestEnvironmentConfig;
  public portForwarder?: PortForwardingService;

  constructor(configPath?: string | TestEnvironmentConfig) {
    this.defaultConfig = loadConfig(configPath);
    const externalDomain = this.defaultConfig.environment?.externalDomain;
    if (externalDomain) {
      this.setExternalDomain(externalDomain);
    }
    setInterval(
      () => this.cleanupInactiveEnvironments(),
      this.defaultConfig.environment?.timeouts?.inactive ?? theDefaultConfig.environment!.timeouts!.inactive
    );
  }
  setExternalDomain(extDomain: string) {
    if (extDomain) {
      this.portForwarder = new PortForwardingService(extDomain);
    }
  }
  private async cloneRepo(branch?: string, config?: TestEnvironmentConfig): Promise<string> {
    const workDir = path.join(os.tmpdir(), `test-env-${uuidv4()}`);
    await fs.promises.mkdir(workDir, { recursive: true });

    const gitConfig = config?.git ?? this.defaultConfig.git!;
    if (!gitConfig?.repoUrl) {
      throw new Error("No git repo configured");
    }
    let cloneCmd = `git clone ${gitConfig.repoUrl} ${workDir}`;

    if (gitConfig.auth) {
      if (gitConfig.auth.token) {
        // Use token in URL for HTTPS
        const urlWithAuth = gitConfig.repoUrl.replace(
          'https://',
          `https://${gitConfig.auth.token}@`
        );
        cloneCmd = `git clone ${urlWithAuth} ${workDir}`;
      } else if (gitConfig.auth.sshKeyPath) {
        // Use SSH key
        cloneCmd = `GIT_SSH_COMMAND='ssh -i ${gitConfig.auth.sshKeyPath}' ${cloneCmd}`;
      }
    }
    console.log('cloning the repo...')
    await execAsync(cloneCmd);
    if (branch) {
      console.log('Checking out')
      await execAsync(`cd ${workDir} && git checkout ${branch}`);
    }
    return workDir;
  }

  private async buildImage(workDir: string, config: TestEnvironmentConfig): Promise<string> {
    if (!config.docker) {
      throw new Error("No docker config");
    }
    const { baseImage } = config.docker;
    if (!baseImage) {
      return config.docker.image!;
    }

    await this.docker.buildImage({
      context: baseImage.context ? path.join(workDir, baseImage.context) : workDir,
      src: [baseImage.dockerfile ?? this.defaultConfig.docker!.baseImage!.dockerfile!],
    }, {
      t: baseImage.tag,
      buildargs: baseImage.buildArgs ?? this.defaultConfig.docker!.baseImage!.buildArgs
    });

    return baseImage.tag!;
  }

  async createEnvironment(
    requestConfig: Partial<TestEnvironmentConfig>,
    branch: string,
    dbSnapshot?: string
  ): Promise<Environment> {
    // Merge request config with default config
    const config = {
      ...this.defaultConfig,
      ...requestConfig,
      git: {
        ...this.defaultConfig.git,
        ...requestConfig.git,
      },
      docker: {
        ...this.defaultConfig.docker,
        ...requestConfig.docker,
      },
      environment: {
        ...this.defaultConfig.environment,
        ...requestConfig.environment,
      }
    };

    // Rest of environment creation
    const id = uuidv4();
    const port = await this.findAvailablePort(config);

    const env: Environment = {
      id,
      branch,
      dbSnapshot,
      port,
      status: 'starting',
      url: `http://localhost:${port}`,
      lastAccessed: new Date()
    };

    // Generate port identifier and register with forwarder
    const portIdentifier = `port_${env.port}`;
    if (this.portForwarder) {
      this.portForwarder.registerPort(portIdentifier, env.port);
      env.externalUrl = this.portForwarder.getUrl(portIdentifier) || env.url;
    }

    this.environments.set(id, env);

    try {
      // Clone repository
      env.workDir = await this.cloneRepo(branch, config);

      // Start container(s) based on configuration
      if (config.docker?.dockerCompose) {
        await this.startWithDockerCompose(env.workDir, env, config);
      } else {
        await this.startWithDocker(env.workDir, env, config);
      }

      // Wait for service to be ready
      await this.waitForService(env, config);
      env.status = 'ready';
    } catch (error) {
      env.status = 'error';
      console.log(`had an error, cleaning up environment ${env.id}`);
      await this.cleanupEnvironment(env.id);
      console.log(`cleaned up environment ${env.id}`);
      console.error(`Failed to create environment: ${error}`);
      throw error;
    }

    return env;
  }

  private async startWithDockerCompose(
    workDir: string,
    env: Environment,
    config: TestEnvironmentConfig
  ): Promise<void> {
    const composeConfig = config.docker?.dockerCompose;
    if (!composeConfig) throw new Error("No Docker Compose configuration provided");

    const composeFile = path.resolve(workDir, composeConfig.composeFile || './docker-compose.yml');
    const mainService = composeConfig.mainService || 'app';
    let envFile: string | undefined;
    if (composeConfig.envFile) {
      envFile = path.resolve(workDir, composeConfig.envFile);
    }
    else if (composeConfig.envFileData) {
      const envFilePath = path.resolve(workDir, '.tev_env_file');
      fs.writeFileSync(envFilePath, composeConfig.envFileData);
      envFile = envFilePath;
    }
    env.isCompose = true;
    env.composeFile = composeFile;
    env.envFile = envFile;

    // const docker = new Docker();
    // Create compose instance
    // const compose = new DockerCompose(docker, composeFile, mainService);
    console.log('about to create compose setup for', composeFile, 'at directory', workDir);
    // If a custom template is provided, write it to the compose file
    if (composeConfig.composeTemplate) {
      // Replace template variables
      const template = composeConfig.composeTemplate
        .replace('${PORT}', env.port.toString())
        .replace('${CONTAINER_PORT}', (config.environment?.containerPort || 3000).toString());

      await fs.promises.writeFile(
        path.join(workDir, composeFile),
        template
      );
    }
    // Spin up our stuff
    await upDockerCompose({ workDir, composeFile, envFile });

    // Get docker containers and their original compose working directories
    // await execAsync(`docker inspect --format='container name: {{.Name}}, path: {{index (index .Config.Labels "com.docker.compose.project.working_dir")}}' $(docker ps -q)`)

    // Get docker containers associated with a original compose directory, and make it json format!
    const resultingContainers = await getDockerComposeServicesByWorkDir(workDir);
    // console.log('pulling compose...');
    // // Start compose services
    // await compose.pull();
    // console.log('running compose up...');
    // const composeUpResults = await compose.up();
    // console.log('Completed compose up');
    // // Get container ID of main service
    // const services = composeUpResults.services;
    // Store all container information
    env.containers = {
      mainService,
      containers: resultingContainers.map((v) => {
        return {
          id: v.ID,
          name: v.Names
        }
      })
    };
    // const mainContainer = env.containers.containers.find(s => s.name === mainService);
    // if (!mainContainer) {
    //   throw new Error(`Main service '${mainService}' not found`);
    // }
    // env.containerId = mainContainer.id;
  }

  private async startWithDocker(
    workDir: string,
    env: Environment,
    config: TestEnvironmentConfig
  ): Promise<void> {
    const imageTag = await this.buildImage(workDir, config);
    const containerPort = config.environment?.containerPort ?? 3000;

    const containerEnv = {
      ...config.environment?.serverEnv,
      GIT_BRANCH: env.branch,
      PORT: containerPort.toString(),
      ...(env.dbSnapshot ? { DB_SNAPSHOT: env.dbSnapshot } : {})
    };

    const container = await this.docker.createContainer({
      Image: imageTag,
      ExposedPorts: {
        [`${containerPort}/tcp`]: {}
      },
      HostConfig: {
        PortBindings: {
          [`${containerPort}/tcp`]: [{ HostPort: env.port.toString() }]
        },
        Binds: [
          `${workDir}:/app`,
          ...(config.environment?.mongodb?.snapshotsPath
            ? [`${config.environment.mongodb.snapshotsPath}:/snapshots`]
            : [])
        ]
      },
      Env: Object.entries(containerEnv).map(([k, v]) => `${k}=${v}`)
    });

    await container.start();
    env.containerId = container.id;
  }


  private async waitForService(env: Environment, config?: TestEnvironmentConfig): Promise<void> {
    const startTime = Date.now();
    const timeout = config?.environment?.timeouts?.startup ?? this.defaultConfig.environment!.timeouts!.startup!;

    while (Date.now() - startTime < timeout) {
      try {
        const response = await fetch(`http://localhost:${env.port}/health`);
        if (response.ok) return;
      } catch {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    throw new Error('Service failed to start within timeout');
  }

  async cleanupEnvironment(id: string) {
    const env = this.environments.get(id);
    if (!env) return;

    try {
      if (env.containerId) {
        const container = this.docker.getContainer(env.containerId);
        await container.stop();
        await container.remove();
      }
      if (env.composeFile) {
        const theServices = await getComposeFileServices(env.composeFile)
        await destroyComposeFileServices(env);
      }
      if (this.portForwarder) {
        const portIdentifier = `port_${env.port}`;
        this.portForwarder.removePort(portIdentifier);
      }
      if (env.workDir) {
        await fs.promises.rm(env.workDir, { recursive: true, force: true });
      }
    } finally {
      this.environments.delete(id);
    }
  }

  private async cleanupInactiveEnvironments() {
    const now = new Date();
    for (const [id, env] of this.environments.entries()) {
      if (now.getTime() - env.lastAccessed.getTime() > (this.defaultConfig?.environment?.timeouts?.inactive ?? this.defaultConfig.environment!.timeouts!.inactive!)) {
        await this.cleanupEnvironment(id);
      }
    }
  }

  private async cleanupOldestEnvironment() {
    let oldest: Environment | null = null;
    for (const env of this.environments.values()) {
      if (!oldest || env.lastAccessed < oldest.lastAccessed) {
        oldest = env;
      }
    }
    if (oldest) {
      await this.cleanupEnvironment(oldest.id);
    }
  }

  private async findAvailablePort(config?: TestEnvironmentConfig): Promise<number> {
    const { start, end } = config?.environment?.portRange ?? this.defaultConfig.environment!.portRange!;
    // Implementation to find next available port in range
    // You might want to use a port-finder library here
    const usedPorts = new Set(Array.from(this.environments.values()).map(e => e.port));
    for (let port = start; port <= end; port++) {
      if (!usedPorts.has(port)) return port;
    }
    throw new Error('No available ports');
  }
}

async function getDockerComposeServicesByWorkDir(workDir: string) {
  const resultingContainersRaw = await execAsync(`docker ps --filter "label=com.docker.compose.project.working_dir=${escapeQuotedArgumentPath(workDir)}" --format '{{ json .}}'`);
  const resultingContainers = formatDockerJSONOutputString(resultingContainersRaw);
  return resultingContainers;
}

async function upDockerCompose(args: { workDir?: string, composeFile: string, envFile?: string }) {
  const { workDir: _workDir, composeFile, envFile } = args;
  const workDir = _workDir ?? path.dirname(composeFile);
  await execAsync(`docker compose --project-directory ${escapeQuotedArgumentPath(workDir)} -f ${escapeQuotedArgumentPath(composeFile)}${envFile ? ` --env-file ${escapeQuotedArgumentPath(envFile)}` : ''} up -d`);
}

async function destroyComposeFileServices(env: Environment) {
  await execAsync(`docker compose down ${env.composeFile}`);
}

// Express server setup
export function createServer(configPath?: string | TestEnvironmentConfig) {
  const app = express();
  const manager = new EnvironmentManager(configPath);
  const previousEnvironments = manager.environments.entries();
  for (const [envId, env] of previousEnvironments) {
    console.log('cleaning up previous environment', envId, 'at path', env.workDir);
    manager.cleanupEnvironment(envId);
  }

  app.post('/environments', express.json(), async (req, res) => {
    const { branch, dbSnapshot, config } = req.body;
    try {
      const env = await manager.createEnvironment(config || {}, branch, dbSnapshot);
      res.json(env);
    } catch (error) {
      res.status(500).json({ error: 'Failed to create environment' });
    }
  });

  app.get('/environments/list', express.json(), async (req, res) => {
    const entries = manager.environments.entries();
    const ret: { id: string, env: Environment }[] = [];
    for (const entry of entries) {
      const [id, env] = entry;
      ret.push({ id, env });
    }
    res.json({ environments: ret });
  });

  app.get('/environments/:id', async (req, res) => {
    const env = manager.environments.get(req.params.id);
    if (!env) {
      res.status(404).json({ error: 'Environment not found' });
      return;
    }
    env.lastAccessed = new Date();
    res.json(env);
  });

  app.delete('/environments/:id', async (req, res) => {
    try {
      await manager.cleanupEnvironment(req.params.id);
      res.status(204).send();
    } catch (error) {
      res.status(500).json({ error: 'Failed to cleanup environment' });
    }
  });

  return { app, manager };
}

/**
 * Function to safely escape workDir paths for shell execution
 * @param {string} workDir - The working directory path
 * @returns {string} - Escaped workDir for shell usage
 */
function escapeQuotedArgumentPath(value: string) {
  // Escape double quotes and backslashes in the value
  return value.replace(/["\\]/g, '\\$&');
}

type DockerPsEntry = {
  Command: string;
  CreatedAt: string;
  ID: string;
  Image: string;
  Labels: string; // Can be further processed into a key-value object if necessary
  LocalVolumes: string;
  Mounts: string;
  Names: string;
  Networks: string;
  Ports: string;
  RunningFor: string;
  Size: string;
  State: string;
  Status: string;
};

function formatDockerJSONOutputString(rawOutput: string): DockerPsEntry[] {
  // Each line is a JSON object, so split and parse
  const containers = rawOutput
    .trim()
    .split("\n")
    .map(line => JSON.parse(line));
  console.log(JSON.stringify(containers, null, 2)); // Pretty-print JSON
  return containers;
}

async function getComposeFileServices(composePath: string) {
  const res = await execAsync(`docker ps --filter "label=com.docker.compose.project.config_files=${escapeQuotedArgumentPath(composePath)}" --format '{{json .}}'`);
  return formatDockerJSONOutputString(res);
}