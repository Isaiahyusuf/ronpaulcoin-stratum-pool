# pooler/cpuminer 2.5.1 (GPL-2.0), used only for local regtest miner compatibility checks.
FROM ubuntu:16.04 AS build
ADD https://github.com/pooler/cpuminer/archive/refs/tags/v2.5.1.tar.gz /src.tar.gz
RUN echo "eac6bfc4e1924a5743ce5dec79c9502fe15f2181b22d205e320cb8d64d0bd39c  /src.tar.gz" | sha256sum -c - \
    && apt-get update && apt-get install -y --no-install-recommends ca-certificates build-essential autoconf automake libcurl4-openssl-dev libjansson-dev \
    && tar xzf /src.tar.gz && cd cpuminer-2.5.1 && ./autogen.sh && ./configure CFLAGS="-O2" && make -j2

FROM ubuntu:16.04
RUN apt-get update && apt-get install -y --no-install-recommends libcurl3 libjansson4 && rm -rf /var/lib/apt/lists/*
COPY --from=build /cpuminer-2.5.1/minerd /usr/local/bin/minerd
USER nobody
ENTRYPOINT ["minerd"]
