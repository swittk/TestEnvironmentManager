Example usage

export TSMANAGER_EXTERNAL_DOMAIN=testing.mysite.com && export TSMANAGER_SERVER_PORT_DOMAIN=testenv && pnpm start
// This will spin up an instance at testenv.testing.mysite.com, and you get dynamic domains at port_xxxx.testing.mysite.com

The default management port is at port 3500, this can be configured via the PORT environment variable!