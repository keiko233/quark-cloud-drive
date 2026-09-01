FROM denoland/deno:latest

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends socat \
	&& rm -rf /var/lib/apt/lists/*

COPY . .

RUN deno cache main.ts
RUN chmod +x /app/docker-entrypoint.sh

EXPOSE 3000

CMD ["/app/docker-entrypoint.sh"]