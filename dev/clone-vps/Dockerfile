# A pretend fresh Debian VPS with its OWN Docker daemon (Docker-in-Docker), for testing "Clone server".
# Unlike srv-a/srv-b it does not touch the Mac's Docker, so cloning can't affect your own containers.
#   INSTALL_DOCKER=1 → Docker already installed (the source server)
#   INSTALL_DOCKER=0 → no Docker (a brand-new target; Switchboard installs it)
FROM debian:bookworm-slim
ARG INSTALL_DOCKER=0
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update -q \
 && apt-get install -y -q --no-install-recommends openssh-server ca-certificates curl gzip tar procps iproute2 iptables sudo tzdata passwd \
 && if [ "$INSTALL_DOCKER" = "1" ]; then curl -fsSL https://get.docker.com | sh; fi \
 && rm -rf /var/lib/apt/lists/* \
 && sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config \
 && sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config \
 && mkdir -p /root/.ssh /run/sshd && chmod 700 /root/.ssh
COPY start.sh /start.sh
RUN chmod +x /start.sh
CMD ["/start.sh"]
