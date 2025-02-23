import fs from 'fs';
import path from 'path';

export interface GitConfig {
  /**
   * The URL of the Git repository to clone
   * Supports both HTTPS and SSH URLs
   * Example: 'https://github.com/user/repo.git' or 'git@github.com:user/repo.git'
   */
  repoUrl?: string;

  /**
   * Authentication settings for private repositories
   */
  auth?: {
    /** Username for HTTPS authentication */
    username?: string;

    /**
     * Personal access token or password
     * Recommended to use environment variable: process.env.GIT_TOKEN
     */
    token?: string;

    /**
     * Path to SSH private key for SSH authentication
     * Example: '~/.ssh/id_rsa' or '/path/to/private_key'
     */
    sshKeyPath?: string;
  };

  /**
   * Default branch to use when none is specified
   * @default 'main'
   */
  defaultBranch?: string;
}

interface ServicePorts {
  [serviceName: string]: {
    containerPort: number;
    hostPort: number;
  }[];
}

export interface DockerConfig {
  /**
   * Configuration for building a custom Docker image
   * If not provided, will use 'image' property instead
   */
  baseImage?: {
    /**
     * Path to Dockerfile, relative to repository root
     * @default './Dockerfile'
     */
    dockerfile?: string;

    /**
     * Build context directory, relative to repository root
     * @default '.'
     */
    context?: string;

    /**
     * Tag for the built image
     * @default 'test-server:latest'
     */
    tag?: string;

    /**
     * Build arguments passed to Docker build
     * Example: { NODE_VERSION: '18', ENV: 'test' }
     */
    buildArgs?: Record<string, string>;
  };

  /**
   * Pre-built image to use instead of building from source
   * Example: 'node:18' or 'your-registry.com/image:tag'
   */
  image?: string;

  /**
 * Docker Compose configuration instead of single image
 */
  dockerCompose?: {
    /**
     * Path to Dockerfile, relative to repository root
     * @default './docker-compose.yml'
     */
    composeFile?: string;

    /**
     * Service name to use for the main service
     * @default 'app'
     */
    mainService?: string;

    /**
     * Custom compose file content template
     */
    composeTemplate?: string;
    /**
     * Specific environment file to use
     */
    envFile?: string;
    /**
     * Specific environment file data to use
     */
    envFileData?: string;
  };


  /**
   * Private registry configuration
   */
  registry?: {
    /** Registry URL (e.g., 'registry.gitlab.com') */
    url?: string;
    /** Registry username */
    username?: string;
    /** Registry password or token */
    password?: string;
  };
}

export interface EnvironmentConfig {
  /**
   * Environment variables passed to each test environment
   * These will be available inside the container
   * Example: { NODE_ENV: 'test', LOG_LEVEL: 'debug' }
   */
  serverEnv?: Record<string, string>;

  /** The external domain to use as the base for the port mapping */
  externalDomain?: string;

  /**
   * Port range for spawned test environments
   * Each environment gets a unique port from this range
   */
  portRange?: {
    /** Starting port number @default 3000 */
    start: number;
    /** Ending port number @default 3100 */
    end: number;
  };
  /**
   * Port inside the container
   * Example: 3000 for a Node.js server
   * @default 3000
   */
  containerPort?: number;

  /**
   * Maximum number of concurrent test environments
   * When exceeded, oldest inactive environment is removed
   * @default 5
   */
  maxEnvironments?: number;

  /**
   * Timeout settings in milliseconds
   */
  timeouts?: {
    /**
     * Maximum time to wait for environment to start
     * Includes time for container startup and health check
     * @default 60000 (1 minute)
     */
    startup?: number;

    /**
     * Time after which inactive environments are cleaned up
     * Measured from last access time
     * @default 3600000 (1 hour)
     */
    inactive?: number;
  };

  /**
   * MongoDB-specific configuration
   */
  mongodb?: {
    /**
     * MongoDB connection URL
     * Example: 'mongodb://localhost:27017/test'
     */
    url?: string;

    /**
     * Directory containing database snapshots
     * Will be mounted at /snapshots in the container
     * Example: './db-snapshots'
     */
    snapshotsPath?: string;
  };
}

export interface TestEnvironmentConfig {
  git?: GitConfig;
  docker?: DockerConfig;
  environment?: EnvironmentConfig;
}

/**
 * Default configuration values
 * These are used when specific options are not provided
 */
export const defaultConfig: TestEnvironmentConfig = {
  git: {
    defaultBranch: 'main'
  },
  docker: {
    baseImage: {
      dockerfile: './Dockerfile',
      context: '.',
      tag: 'test-server:latest'
    }
  },
  environment: {
    serverEnv: {
      NODE_ENV: 'test'
    },
    containerPort: 3000,
    portRange: {
      start: 3000,
      end: 3100
    },
    maxEnvironments: 5,
    timeouts: {
      startup: 60000,    // 1 minute
      inactive: 3600000  // 1 hour
    }
  }
};

/**
 * Loads and merges configuration from various sources
 * 
 * @param configInput - Configuration input in one of these formats:
 *   - File path (string) to .json or .ts/.js file
 *   - JSON string
 *   - Configuration object
 *   - undefined (uses defaults)
 * 
 * @example
 * // Using a file
 * const config = loadConfig('./test-config.json');
 * 
 * @example
 * // Using an object
 * const config = loadConfig({
 *   git: { repoUrl: 'https://github.com/user/repo.git' }
 * });
 * 
 * @example
 * // Using JSON string
 * const config = loadConfig('{"git":{"defaultBranch":"develop"}}');
 * 
 * @returns Merged configuration with defaults
 */
export function loadConfig(configInput?: string | TestEnvironmentConfig): TestEnvironmentConfig {
  if (!configInput) {
    return defaultConfig;
  }

  let userConfig: TestEnvironmentConfig;

  if (typeof configInput === 'string') {
    // Check if the string is a file path
    if (fs.existsSync(configInput)) {
      const ext = path.extname(configInput);
      if (ext === '.json') {
        userConfig = JSON.parse(fs.readFileSync(configInput, 'utf-8'));
      } else if (ext === '.js' || ext === '.ts') {
        userConfig = require(configInput);
      } else {
        throw new Error(`Unsupported config file type: ${ext}`);
      }
    } else {
      // Try parsing as JSON string
      try {
        userConfig = JSON.parse(configInput);
      } catch (e) {
        throw new Error('Config string is neither a valid file path nor valid JSON');
      }
    }
  } else {
    // Direct object input
    userConfig = configInput;
  }

  // Deep merge with defaults
  return {
    ...defaultConfig,
    ...userConfig,
    git: {
      ...defaultConfig.git,
      ...userConfig.git,
    },
    docker: {
      ...defaultConfig.docker,
      ...userConfig.docker,
      baseImage: userConfig.docker?.baseImage ? {
        ...(defaultConfig.docker ?? {}).baseImage,
        ...userConfig.docker.baseImage,
      } : (defaultConfig.docker ?? {}).baseImage,
    },
    environment: {
      ...defaultConfig.environment,
      ...userConfig.environment,
      serverEnv: {
        ...defaultConfig.environment?.serverEnv,
        ...userConfig.environment?.serverEnv,
      },
      timeouts: {
        ...defaultConfig.environment?.timeouts,
        ...userConfig.environment?.timeouts,
      }
    }
  };
}