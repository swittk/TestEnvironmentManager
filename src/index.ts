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

}
// Start server
if (require.main === module) {
  main();
}