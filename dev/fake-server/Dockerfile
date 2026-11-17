# A pretend "VPS": SSH server + docker CLI (talks to the host's Docker) + a tiny web server answering /up.
FROM alpine:3.22
RUN apk add --no-cache openssh-server docker-cli bash gzip tar python3 coreutils sed grep \
 && ssh-keygen -A \
 && sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config \
 && sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config \
 && echo 'root:*' | chpasswd -e \
 && mkdir -p /root/.ssh && chmod 700 /root/.ssh
COPY health.py /health.py
COPY start.sh /start.sh
RUN chmod +x /start.sh
CMD ["/start.sh"]
