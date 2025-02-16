// port-forwarder.ts
import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
// import { URL } from 'url';

interface PortMapping {
  port: number;
  lastAccessed: Date;
}

export class PortForwardingService {
  private portMappings = new Map<string, PortMapping>();
  
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
        return res.status(400).send('No hostname provided');
      }

      // Check if this is a testing subdomain request
      if (!hostname.endsWith(this.baseHostname)) {
        return res.status(404).send('Invalid domain');
      }

      // Extract port identifier from subdomain
      const portIdentifier = hostname.split('.')[0];
      if (!portIdentifier.startsWith('port_')) {
        return res.status(400).send('Invalid port identifier');
      }

      const mapping = this.portMappings.get(portIdentifier);
      if (!mapping) {
        return res.status(404).send('Port mapping not found');
      }

      // Update last accessed time
      mapping.lastAccessed = new Date();

      // Create proxy to forward request to correct port
      const proxy = createProxyMiddleware({
        target: `http://localhost:${mapping.port}`,
        changeOrigin: true,
        ws: true, // Enable WebSocket proxy
        xfwd: true // Forward original headers
      });

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
      }
    }
  }
}