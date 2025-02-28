// port-forwarder.ts
import express, { RequestHandler } from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
// import { URL } from 'url';

interface PortMapping {
  port: number;
  lastAccessed: Date;
}

export class PortForwardingService {
  private portMappings = new Map<string, PortMapping>();
  public staticMappings = new Map<string, PortMapping>();
  private proxyCache = new Map<number, RequestHandler>(); // Cache for proxies

  constructor(
    private baseHostname: string = 'testing.mysite.com',
    private cleanupInterval: number = 3600000 // 1 hour
  ) {
    // Cleanup inactive mappings periodically
    setInterval(() => this.cleanupInactiveMappings(), cleanupInterval);
  }

  createServer() {
    const app = express();

    // Middleware to extract port from hostname and forward request
    app.use((req, res, next) => {
      const hostname = req.hostname || req.headers.host;
      if (!hostname) {
        res.status(400).send('No hostname provided');
        return;
      }

      // Check if this is a testing subdomain request
      if (!hostname.endsWith(this.baseHostname)) {
        res.status(404).send('Invalid domain');
        return;
      }

      // Extract port identifier from subdomain
      const portIdentifier = hostname.split('.')[0];

      // exception for static mappings
      if (this.staticMappings.has(portIdentifier)) {
        const mapping = this.staticMappings.get(portIdentifier)!;
        // Update last accessed time
        mapping.lastAccessed = new Date();
        const proxy = this.getOrCreateProxy(mapping.port);
        return proxy(req, res, next);
      }
      if (!portIdentifier.startsWith('port_')) {
        res.status(400).send('Invalid port identifier');
        return;
      }

      const mapping = this.portMappings.get(portIdentifier);
      if (!mapping) {
        res.status(404).send('Port mapping not found');
        return;
      }

      // Update last accessed time
      mapping.lastAccessed = new Date();

      // Create proxy to forward request to correct port
      const proxy = this.getOrCreateProxy(mapping.port);

      return proxy(req, res, next);
    });

    return app;
  }

  // Register a new port mapping
  registerPort(identifier: string, port: number) {
    this.portMappings.set(identifier, {
      port,
      lastAccessed: new Date()
    });
  }
  registerStaticMapping(mappedComponent: string, port: number) {
    this.staticMappings.set(mappedComponent, {
      port,
      lastAccessed: new Date()
    })
  }

  // Remove a port mapping
  removePort(identifier: string) {
    this.portMappings.delete(identifier);
  }

  // Get URL for a port mapping
  getUrl(identifier: string): string | null {
    if (this.portMappings.has(identifier)) {
      return `https://${identifier}.${this.baseHostname}`;
    }
    return null;
  }

  private cleanupInactiveMappings() {
    const now = new Date();
    for (const [identifier, mapping] of this.portMappings.entries()) {
      if (now.getTime() - mapping.lastAccessed.getTime() > this.cleanupInterval) {
        this.portMappings.delete(identifier);
        this.proxyCache.delete(mapping.port); // Remove proxy from cache
      }
    }
  }

  // Helper method to get or create a proxy
  private getOrCreateProxy(port: number): RequestHandler {
    if (!this.proxyCache.has(port)) {
      // Create proxy to forward request to correct port
      const proxy = createProxyMiddleware({
        target: `http://localhost:${port}`,
        changeOrigin: true,
        ws: true, // Enable WebSocket proxy
        xfwd: true, // Forward original headers
        // Set higher max listeners on the proxy
        // onProxyRes: (proxyRes) => {
        //   proxyRes.setMaxListeners(50);
        // },
        // onProxyReq: (proxyReq) => {
        //   proxyReq.setMaxListeners(50);
        // }
      });
      this.proxyCache.set(port, proxy);
      return proxy;
    } else {
      return this.proxyCache.get(port)!;
    }
  }
}