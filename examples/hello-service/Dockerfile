FROM node:24-alpine
WORKDIR /app
COPY --chown=node:node server.mjs ./
ENV NODE_ENV=production PORT=8080
USER node
EXPOSE 8080
CMD ["node", "server.mjs"]
