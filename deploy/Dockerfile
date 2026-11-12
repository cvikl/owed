FROM node:24-alpine
WORKDIR /app
COPY package.json ./
# Installs exactly what package.json lists. With no dependencies this does nothing. If you added
# @paypal/agent-toolkit (README, "PayPal's Agent Toolkit"), a failed install fails the build on purpose.
RUN npm install --omit=dev --no-audit --no-fund
COPY src ./src
COPY scripts ./scripts
COPY web ./web
ENV NODE_ENV=production PORT=8787 DATA_DIR=/data
EXPOSE 8787
CMD ["node", "src/server.js"]
