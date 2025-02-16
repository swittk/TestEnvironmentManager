import { createServer } from "./EnvironmentManager";

async function main() {
  const configPath = process.env.CONFIG_PATH// || './test-config.ts';
  const port = process.env.PORT || 3500;

  const server = createServer(configPath);
  server.listen(port, () => {
    console.log(`Environment manager listening on port ${port}`);
    console.log(`Using configuration from ${configPath}`);
  });

}
// Start server
if (require.main === module) {
  main();
}