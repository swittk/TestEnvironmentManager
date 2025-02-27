// environment-manager.ts
import express from 'express';
import Docker from 'dockerode';
import DockerCompose from 'dockerode-compose';
import { v4 as uuidv4 } from 'uuid';
import { exec } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { TestEnvironmentConfig, defaultConfig as theDefaultConfig, loadConfig, ServicePort } from './config';
import { PortForwardingService } from './port-forwarder';
import { PersistentMap } from './PersistentMap';
import yaml from 'js-yaml';
import detectPort from 'detect-port';
import { EphemeralUploadManager } from './EphemeralUploadManager';
import busboy from 'busboy';

function execAsync(cmd: string) {
  return new Promise<string>((resolve, reject) => {
    exec(cmd, (error, stdout, stderr) => {
      if (error) return reject(error)
      // if (stderr) return reject(stderr)
      resolve(stdout)
    })
  })
}

interface PortDetectionEntry {
  timestamp: number;
}

export interface Environment {
  id: string;
  branch: string;
  dbSnapshot?: string;
  port: number[];
  status: 'starting' | 'ready' | 'error';
  url: string | string[];
  externalUrl?: string | string[];
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
  private portCache: Map<number, PortDetectionEntry> = new Map();
  private readonly CACHE_EXPIRATION_MS = 60000; // 1 minute cache expiration


  private docker = new Docker();
  private defaultConfig: TestEnvironmentConfig;
  public portForwarder?: PortForwardingService;

  public ephemeralUploads = new EphemeralUploadManager();

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

  private async setupAdditionalFiles(workDir: string, config: TestEnvironmentConfig) {
    if (!config.additionalFiles) {
      console.log('no additional files to setup')
      return;
    }
    const allProms: Promise<void>[] = [];
    for (const requestFilePath in config.additionalFiles) {
      const filePath = path.resolve(workDir, requestFilePath);
      const fileConfig = config.additionalFiles[requestFilePath];
      const loopProm = async () => {
        // Extract directory path
        const dir = path.dirname(filePath);

        // Ensure directory exists
        await fs.promises.mkdir(dir, { recursive: true });
        
        if (typeof fileConfig == 'string') {
          // If it is string, it is plain text!
          await fs.promises.writeFile(filePath, fileConfig);
        }
        else {
          if (fileConfig.content) {
            // If there is content, we just write
            if (fileConfig.encoding == 'base64') {
              const bufferToWrite = Buffer.from(fileConfig.content, 'base64');
              await fs.promises.writeFile(filePath, bufferToWrite);
            }
            else {
              // Otherwise just UTF-8
              await fs.promises.writeFile(filePath, fileConfig.content, 'utf-8');
            }
          }
          else {
            // There is NO content; it should be pre-uploaded!
            if (!fileConfig.checksum) {
              throw 'No content or checksum provided';
            }
            const existing = this.ephemeralUploads.getUpload(fileConfig.checksum);
            if (!existing) {
              throw `No existing uploads with the MD5 ${fileConfig.checksum}`;
            }
            else if (!existing.filePath) {
              throw `No existing filePath with the MD5 ${fileConfig.checksum}`;
            }
            else {
              // Copy to the needed path!
              await fs.promises.cp(existing.filePath, filePath);
            }
          }
        }
      }
      allProms.push(loopProm());
    }
    await Promise.all(allProms);
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
      url: Array.isArray(port) ? port.map((p) => { return `http://localhost:${p}` }) : `http://localhost:${port}`,
      lastAccessed: new Date()
    };

    // Generate port identifier and register with forwarder
    if (this.portForwarder) {
      if (Array.isArray(env.port)) {
        const extUrls: string[] = [];
        for (let i = 0; i < env.port.length; i++) {
          const p = env.port[i];
          const portIdentifier = `port_${env.port}`;
          this.portForwarder.registerPort(portIdentifier, p);
          extUrls.push(this.portForwarder.getUrl(portIdentifier) || env.url[i]);
        }
        env.externalUrl = extUrls;
      }
      else {
        const portIdentifier = `port_${env.port}`;
        this.portForwarder.registerPort(portIdentifier, env.port);
        env.externalUrl = this.portForwarder.getUrl(portIdentifier) || env.url;
      }
    }

    this.environments.set(id, env);

    try {
      // Clone repository
      const workDir = await this.cloneRepo(branch, config);
      env.workDir = workDir;
      this.environments.set(id, env); // Update in our cache... it saves!

      await this.setupAdditionalFiles(env.workDir, config);
      // Start container(s) based on configuration
      if (config.docker?.dockerCompose) {
        await this.startWithDockerCompose(env.workDir, env, config);
      } else {
        await this.startWithDocker(env.workDir, env, config);
      }
      // console.log('waiting for service to be ready');
      // Wait for service to be ready
      // await this.waitForService(env, config);
      env.status = 'ready';
    } catch (error) {
      env.status = 'error';
      console.log(`had an error, cleaning up environment ${env.id}`);
      await this.cleanupEnvironment(env.id);
      console.log(`cleaned up environment ${env.id}`);
      console.error(`Failed to create environment: ${error}`);
      throw error;
    }
    this.environments.set(id, env);
    return env;
  }

  private async startWithDockerCompose(
    workDir: string,
    env: Environment,
    config: TestEnvironmentConfig
  ): Promise<void> {
    const composeConfig = config.docker?.dockerCompose;
    if (!composeConfig) throw new Error("No Docker Compose configuration provided");

    let composeFilePath = path.resolve(workDir, composeConfig.composeFile || './docker-compose.yml');
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

    // const docker = new Docker();
    // Create compose instance
    // const compose = new DockerCompose(docker, composeFile, mainService);
    // If a custom template is provided, write it to the compose file
    if (composeConfig.composeTemplate) {
      // Replace template variables
      const template = composeConfig.composeTemplate
        .replace('${PORT}', env.port.toString())
        .replace('${CONTAINER_PORT}', (config.environment?.port || 3000).toString());
      await fs.promises.writeFile(
        composeFilePath,
        template
      );
    }

    // Replace all ports with our needed one
    const composeContent = fs.readFileSync(composeFilePath, 'utf-8');
    const compose = yaml.load(composeContent) as any;
    const portMapToUse = config.docker?.port ?? config.environment?.port;
    // Modify port mappings in the compose file
    const dockerPortMappings: ServicePort[] =
      (portMapToUse != undefined) ?
        Array.isArray(portMapToUse) ? portMapToUse : [{ name: 'default', internalPort: portMapToUse ?? 3000 }] : [{ name: 'default', internalPort: 3000 }];
    const dockerPortMappingsWithHostPort = dockerPortMappings.map((v, idx) => {
      if (!env.port[idx]) {
        throw `No port at index ${idx}`;
      }
      return { ...v, hostPort: env.port[idx] };
    })
    console.log('modifying compose file ports with mapping', dockerPortMappingsWithHostPort)
    for (const [serviceName, service] of Object.entries(compose.services)) {
      // Remove all original `ports` exposure if it isn't one we know.
      const serviceOriginalPorts = (service as any).ports as string[];
      console.log('Original ports:', serviceOriginalPorts);
      if (Array.isArray(serviceOriginalPorts)) {
        const serviceNewPortsWithNull = serviceOriginalPorts.map((portStr) => {
          const foundWantedMapping = dockerPortMappingsWithHostPort.find((wantedInternalPort) => {
            return portStr.includes(`:${wantedInternalPort.internalPort}`);
          });
          console.log(`Checking port string ${portStr}`, foundWantedMapping);
          if (!foundWantedMapping) return null;
          return `${foundWantedMapping.hostPort}:${foundWantedMapping.internalPort}`;
        });
        const serviceNewPorts = serviceNewPortsWithNull.filter((v) => !!v) as string[];
        console.log(`New ports for ${serviceName}:`, serviceNewPorts);
        (service as any).ports = serviceNewPorts;
      }
    }
    // Write modified compose file
    const newComposeContent = yaml.dump(compose);
    await fs.promises.writeFile(
      composeFilePath,
      newComposeContent
    );
    console.log('wrote new compose file');
    console.log('about to create compose setup for', composeFilePath, 'at directory', workDir);
    env.isCompose = true;
    env.composeFile = composeFilePath;
    env.envFile = envFile;
    // Spin up our stuff
    await upDockerCompose({ workDir, composeFile: composeFilePath, envFile });

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
    const containerPort = config.environment?.port ?? 3000;
    const containerEnv = {
      ...config.environment?.serverEnv,
      GIT_BRANCH: env.branch,
      PORT: containerPort.toString(),
      ...(env.dbSnapshot ? { DB_SNAPSHOT: env.dbSnapshot } : {})
    };

    const ExposedPorts: { [port: string]: {} } = {};
    const PortBindings: { [port: string]: any[] } = {};
    if (Array.isArray(containerPort)) {
      for (let i = 0; i < containerPort.length; i++) {
        const p = containerPort[i];
        ExposedPorts[`${p.internalPort}/tcp`] = {}
        PortBindings[`${p.internalPort}/tcp`] = [{ HostPort: env.port[i] }]
      }
    }
    else {
      ExposedPorts[`${containerPort}/tcp`] = {}
      PortBindings[`${containerPort}/tcp`] = [{ HostPort: env.port.toString() }]
    }
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
        if (Array.isArray(env.port)) {
          for (const p of env.port) {
            const portIdentifier = `port_${p}`;
            this.portForwarder.removePort(portIdentifier);
          }
        }
        else {
          const portIdentifier = `port_${env.port}`;
          this.portForwarder.removePort(portIdentifier);
        }
      }
      if (env.workDir) {
        await fs.promises.rm(env.workDir, { recursive: true, force: true });
      }
    } finally {
      this.environments.delete(id);
    }
  }

  async cleanupAllEnvironments() {
    const proms: Promise<any>[] = [];
    for (const [envid, env] of this.environments) {
      proms.push(this.cleanupEnvironment(envid));
    }
    await Promise.allSettled(proms);
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

  private async findAvailablePort(config?: TestEnvironmentConfig): Promise<number[]> {
    const { start, end } = config?.environment?.portRange ?? this.defaultConfig.environment!.portRange!;
    // Implementation to find next available port in range
    // You might want to use a port-finder library here
    const numPortsNeeded = Math.round(Math.max(Array.isArray(config?.environment?.port) ? config.environment.port.length : 1, 1));
    const usedPorts = new Set(Array.from(this.environments.values()).map(e => e.port).flat());

    let ret: number[] = [];
    const now = Date.now();
    for (let port = start; port <= end && ret.length < numPortsNeeded; port++) {
      // Skip if port is already known to be used by our environments
      if (usedPorts.has(port)) {
        continue;
      }
      // Check cache first
      const cacheEntry = this.portCache.get(port);
      if (cacheEntry && (now - cacheEntry.timestamp) < this.CACHE_EXPIRATION_MS) {
        if (cacheEntry) {
          ret.push(port);
        }
        continue;
      }
      // If not in cache or cache expired, check system availability
      try {
        const isAvailable = ((await detectPort(port)) == port);

        if (!isAvailable) {
          // Update cache
          this.portCache.set(port, {
            timestamp: now
          });
        }
        else {
          if (!usedPorts.has(port)) {
            ret.push(port);
          }
        }
      } catch (error) {
        console.warn(`Error checking port ${port}:`, error);
        // Skip this port on error
        continue;
      }
    }
    if (ret.length >= numPortsNeeded) {
      return ret;
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
  await execAsync(`docker compose down -f ${escapeQuotedArgumentPath(env.composeFile!)} --volumes --rmi all --remove-orphans`);
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

  // Endpoint to initiate an upload
  app.post('/uploads/initiate', express.json({ limit: '5mb' }), async (req, res) => {
    const { md5, fileName, fileSize } = req.body;
    if (!md5) {
      res.status(400).json({ error: 'Missing md5' });
      return;
    }
    const existing = manager.ephemeralUploads.initiateUpload(md5, fileName, fileSize);
    res.json(existing);
  });

  // Endpoint to perform the actual file upload
  // Expecting file data as a Base64 encoded string in the JSON body
  app.post('/uploads/:token', async (req, res) => {
    const token = req.params.token;
    if (!token) {
      res.status(400).json({ error: 'Token is required' });
      return;
    }

    // Create busboy instance configured from the request headers
    const bb = busboy({ headers: req.headers });

    // Flag to track if we've handled a file
    let fileHandled = false;

    // Handle file field - this is called when a file part is encountered
    bb.on('file', async (fieldname, fileStream, filename, encoding, mimetype) => {
      // We only want to process the 'file' field
      if (fieldname !== 'file') {
        fileStream.resume(); // Skip this field
        return;
      }

      // Mark that we're handling a file
      fileHandled = true;

      try {
        // Stream the file directly to our upload manager
        const result = await manager.ephemeralUploads.handleFileUpload(token, fileStream);
        res.status(200).json(result);
      } catch (error) {
        // Handle errors during streaming
        res.status(400).json({ error: error.message });
      }
    });

    // Handle errors from busboy
    bb.on('error', (error) => {
      res.status(400).json({ error: `Parse error: ${(error as any).message}` });
    });
    // Handle the end of the request
    bb.on('finish', () => {
      // If no file was processed, send an error
      if (!fileHandled) {
        res.status(400).json({ error: 'No file was uploaded' });
      }
    });

    // Pipe the request to busboy
    req.pipe(bb);
  });

  app.post('/uploads-base64/:token', express.json({ limit: '500mb' }), async (req, res) => {
    const token = req.params.token;
    const { fileData } = req.body;
    if (!fileData) {
      res.status(400).json({ error: 'Missing fileData' });
      return;
    }
    try {
      const uploadEntry = await manager.ephemeralUploads.handleFileUploadBase64(token, fileData);
      res.status(200).json({ success: true, token, md5: uploadEntry.md5 });
      return;
    }
    catch (e) {
      res.status(400).json({ error: e?.message ?? e?.code ?? e });
      return;
    }
  });

  // For handling base64 data streams
  // app.post('/api/upload-base64/:token', express.text({ limit: '50mb' }), async (req, res) => {
  //   const { token } = req.params;

  //   if (!token) {
  //     return res.status(400).json({ error: 'Token is required' });
  //   }

  //   const base64Data = req.body;

  //   if (!base64Data) {
  //     return res.status(400).json({ error: 'Base64 data is required' });
  //   }

  //   try {
  //     // Create a readable stream from the base64 string
  //     const { Readable } = require('stream');
  //     const dataStream = new Readable();

  //     // Push the data to the stream and signal the end
  //     dataStream.push(base64Data);
  //     dataStream.push(null);

  //     // Process the stream with our upload manager
  //     const result = await uploadManager.handleBase64UploadStream(token, dataStream);
  //     res.status(200).json(result);
  //   } catch (error) {
  //     res.status(400).json({ error: error.message });
  //   }
  // });

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