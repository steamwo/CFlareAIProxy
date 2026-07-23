FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.mjs ./
ENV PORT=9090
EXPOSE 9090
CMD ["node", "server.mjs"]
