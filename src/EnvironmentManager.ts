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
      service: Docker.ContainerInspectInfo;
    }>;
  };
  isCompose?: boolean;
  lastAccessed: Date;
  workDir?: string;
}

export class EnvironmentManager {
  public environments: Map<string, Environment> = new Map();
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
  private async cloneRepo(branch: string, config?: TestEnvironmentConfig): Promise<string> {
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

    await exec(cloneCmd);
    await exec(`cd ${workDir} && git checkout ${branch}`);

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

    const docker = new Docker();
    // Create compose instance
    const compose = new DockerCompose(docker, composeFile, workDir);

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

    // Start compose services
    const composeUpResults = await compose.up();
    // Get container ID of main service
    const services = composeUpResults.services;
    // Store all container information
    env.isCompose = true;
    env.containers = {
      mainService,
      containers: await Promise.all(services.map(async service => {
        const serviceInfo = (await service.inspect());
        return {
          id: service.id,
          service: serviceInfo,
          name: serviceInfo.Name,
        }
      })
      )
    };
    const mainContainer = env.containers.containers.find(s => s.name === mainService);
    if (!mainContainer) {
      throw new Error(`Main service '${mainService}' not found`);
    }
    env.containerId = mainContainer.id;
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

// Express server setup
export function createServer(configPath?: string | TestEnvironmentConfig) {
  const app = express();
  const manager = new EnvironmentManager(configPath);

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