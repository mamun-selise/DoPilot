FROM node:22-alpine AS builder

WORKDIR /app

COPY package*.json ./

RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

COPY . .

ARG ci_build=dev
ARG VITE_BLOCKS_API_URL
ARG VITE_BLOCKS_PROJECT_KEY
ARG VITE_BLOCKS_X_BLOCKS_KEY
ARG VITE_BLOCKS_APP_DOMAIN
ARG VITE_BLOCKS_OIDC_URL=https://iam.seliseblocks.com
ARG VITE_BLOCKS_OIDC_CLIENT_ID
ARG VITE_BLOCKS_OIDC_SCOPE="openid profile"
ARG VITE_BLOCKS_REDIRECT_URI
ARG VITE_BLOCKS_HOSTED_LOGIN=true
ARG KORA_CLI_CLIENT_ID
ARG VITE_KORA_HUB_URL

ENV VITE_BLOCKS_API_URL=${VITE_BLOCKS_API_URL}
ENV VITE_BLOCKS_PROJECT_KEY=${VITE_BLOCKS_PROJECT_KEY}
ENV VITE_BLOCKS_X_BLOCKS_KEY=${VITE_BLOCKS_X_BLOCKS_KEY}
ENV VITE_BLOCKS_APP_DOMAIN=${VITE_BLOCKS_APP_DOMAIN}
ENV VITE_BLOCKS_OIDC_URL=${VITE_BLOCKS_OIDC_URL}
ENV VITE_BLOCKS_OIDC_CLIENT_ID=${VITE_BLOCKS_OIDC_CLIENT_ID}
ENV VITE_BLOCKS_OIDC_SCOPE=${VITE_BLOCKS_OIDC_SCOPE}
ENV VITE_BLOCKS_REDIRECT_URI=${VITE_BLOCKS_REDIRECT_URI}
ENV VITE_BLOCKS_HOSTED_LOGIN=${VITE_BLOCKS_HOSTED_LOGIN}
ENV KORA_CLI_CLIENT_ID=${KORA_CLI_CLIENT_ID}
ENV VITE_KORA_HUB_URL=${VITE_KORA_HUB_URL}

RUN NODE_OPTIONS="--max-old-space-size=4096" npx vite build --mode "${ci_build}" \
  && node scripts/write-release-env.mjs "${ci_build}" \
  && node scripts/pack-kora.mjs

# KORA backend (api/): serves the built web app from wwwroot, the KORA CLI tarballs and the runners hub.
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS api
WORKDIR /src
COPY api/DoPilot.Api.csproj api/
RUN dotnet restore api/DoPilot.Api.csproj
COPY api/ api/
RUN dotnet publish api/DoPilot.Api.csproj -c Release -o /out --no-restore

FROM mcr.microsoft.com/dotnet/aspnet:10.0
WORKDIR /app
COPY --from=api /out .
COPY --from=builder /app/dist ./wwwroot
ENV ASPNETCORE_URLS=http://+:8080
EXPOSE 8080
USER $APP_UID
ENTRYPOINT ["dotnet", "DoPilot.Api.dll"]
