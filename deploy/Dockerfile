FROM node:24-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY scripts ./scripts
COPY web ./web
ENV NODE_ENV=production PORT=8787 DATA_DIR=/data
EXPOSE 8787
CMD ["node", "src/server.js"]
