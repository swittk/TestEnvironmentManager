FROM node:18

WORKDIR /app

# Install pnpm
RUN npm install -g pnpm

# Copy workspace configuration
COPY pnpm-workspace.yaml ./
COPY package.json ./
COPY pnpm-lock.yaml ./

# Copy server and shared packages
COPY server ./server
COPY shared ./shared

# Install dependencies
RUN pnpm install

# Script to checkout specific branch and start server
COPY scripts/start-server.sh ./
RUN chmod +x start-server.sh

CMD ["./start-server.sh"]