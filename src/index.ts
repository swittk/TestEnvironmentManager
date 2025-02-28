import { createServer } from "./EnvironmentManager";

async function main() {
  const testEnvironmentManagerExternalDomain = process.env.TSMANAGER_EXTERNAL_DOMAIN;
  const configPath = process.env.CONFIG_PATH// || './test-config.ts';
  const port = process.env.PORT || 3500;

  const { app: server, manager } = createServer(configPath);
  if (testEnvironmentManagerExternalDomain) {
    manager.setExternalDomain(testEnvironmentManagerExternalDomain);
    const portForwarder = manager.portForwarder;
    if (!portForwarder) {
      throw 'F';
    }
    const portforwarder_port = process.env.PORTFORWARDER_PORT || 3501;
    const staticMapServerPortDomain = process.env.TSMANAGER_SERVER_PORT_DOMAIN;
    if (staticMapServerPortDomain) {
      portForwarder.registerStaticMapping(staticMapServerPortDomain, Number(port));
    }
    portForwarder.createServer().listen(portforwarder_port, () => {
      console.log(`Environment manager port forwarder listening on port ${portforwarder_port}`);
    });
  }
  server.listen(port, () => {
    console.log(`Environment manager listening on port ${port}`);
    console.log(`Using configuration from ${configPath}`);
  });
  async function shutdown(signal: string) {
    console.log(`\nReceived ${signal}, cleaning up...`);
    try {
      console.log('cleaning up ephemeral uploads');
      manager.ephemeralUploads.cleanup();
      console.log('cleaned up ephemeral uploads');
      console.log('cleaning up environments')
      await manager.cleanupAllEnvironments();
      console.log('All environments cleaned up successfully');
      process.exit(0);
    } catch (error) {
      console.error('Error during cleanup:', error);
      process.exit(1);
    }
  }

  process.on('SIGINT', () => shutdown('SIGINT')); // Ctrl+C
  process.on('SIGTERM', () => shutdown('SIGTERM')); // kill command

}
// Start server
if (require.main === module) {
  main();
}