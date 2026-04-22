FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
COPY server/package*.json ./server/
COPY webview-ui/package*.json ./webview-ui/
RUN npm install
