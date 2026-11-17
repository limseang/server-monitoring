# Fake GitHub for the test lab: REST API subset + git server (git://) + a stand-in Actions runner download.
FROM node:24-alpine
RUN apk add --no-cache git git-daemon tar
WORKDIR /srv
COPY fake-runner /srv/fake-runner
RUN chmod +x /srv/fake-runner/*.sh /srv/fake-runner/bin/*.sh && tar czf /srv/runner.tgz -C /srv/fake-runner .
COPY server.js /srv/server.mjs
EXPOSE 8788 9418
CMD ["node", "/srv/server.mjs"]
