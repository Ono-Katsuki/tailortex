# TailorTeX — Cloud Run compilation service
#
# texlive-full は数GBと重いため、scheme-small を土台に日本語(langjapanese)と
# LuaLaTeX(luatex)コレクション、および文書で使うパッケージ群だけを追加する。
# ビルドは Cloud Build 側で行うので、開発マシンに Docker は不要(DEPLOY.md 参照)。
#
# ステージ1: TeX Live を tlmgr で構築(debian:bookworm-slim ベース)
# ステージ2: node:20-slim に TeX Live 一式と node アプリを載せる
#
# セルフレビュー(hadolint 相当): apt は --no-install-recommends、キャッシュ削除、
# COPY は必要物のみ、非 root ユーザで実行、HEALTHCHECK あり、PIN された base image。

# ---------------------------------------------------------------------------
# ステージ1: TeX Live のインストール
# ---------------------------------------------------------------------------
FROM debian:bookworm-slim AS texlive

ENV DEBIAN_FRONTEND=noninteractive
ENV PATH=/usr/local/texlive/bin/x86_64-linux:$PATH

# TeX Live の install-tl と最小限のビルドツール
RUN apt-get update && apt-get install -y --no-install-recommends \
      wget \
      ca-certificates \
      perl \
      tar \
      gzip \
      xz-utils \
      fontconfig \
    && rm -rf /var/lib/apt/lists/*

# install-tl のプロファイル(scheme-small)を書き出して非対話インストール
WORKDIR /tmp/tl
RUN wget -q https://mirror.ctan.org/systems/texlive/tlnet/install-tl-unx.tar.gz \
    && tar -xzf install-tl-unx.tar.gz --strip-components=1 \
    && printf '%s\n' \
      'selected_scheme scheme-small' \
      'TEXDIR /usr/local/texlive' \
      'TEXMFLOCAL /usr/local/texlive/texmf-local' \
      'TEXMFSYSVAR /usr/local/texlive/texmf-var' \
      'TEXMFSYSCONFIG /usr/local/texlive/texmf-config' \
      'instopt_adjustpath 0' \
      'tlpdbopt_install_docfiles 0' \
      'tlpdbopt_install_srcfiles 0' \
      > /tmp/tl.profile \
    && ./install-tl --profile=/tmp/tl.profile --no-interaction \
    && rm -rf /tmp/tl

# 必要なコレクション/パッケージを追加。
# collection-langjapanese: 日本語(bxjscls/ltjsclasses/luatexja 等を含む)
# collection-luatex:       LuaLaTeX と luaotfload 等
# 個別: latexmk, todonotes, ulem, geometry, hyperref, tagpdf, pdfmanagement-testphase,
#       bxjscls(bxjs*), jlreq, luatexja(日本語luatex), microtype, xcolor, graphics
RUN tlmgr install \
      collection-langjapanese \
      collection-luatex \
      latexmk \
      todonotes \
      ulem \
      geometry \
      hyperref \
      tagpdf \
      pdfmanagement-testphase \
      bxjscls \
      jlreq \
      luatexja \
      microtype \
      xcolor \
      graphics \
      preview \
      l3packages \
      l3kernel \
      l3experimental \
    && luaotfload-tool --update || true

# ---------------------------------------------------------------------------
# ステージ2: Node ランタイム + TeX Live
# ---------------------------------------------------------------------------
FROM node:20-slim AS runtime

ENV DEBIAN_FRONTEND=noninteractive
ENV PATH=/usr/local/texlive/bin/x86_64-linux:$PATH
ENV PORT=8080

# 実行時ランタイム依存(TeX Live が必要とする perl/fontconfig、python3 は
# アクセシブルPDFの inject_alt 用。PyMuPDF は任意=無ければスキップされる)。
RUN apt-get update && apt-get install -y --no-install-recommends \
      perl \
      fontconfig \
      ghostscript \
      python3 \
    && rm -rf /var/lib/apt/lists/*

# ステージ1で構築した TeX Live をまるごとコピー
COPY --from=texlive /usr/local/texlive /usr/local/texlive

WORKDIR /app

# 依存を先に入れてレイヤキャッシュを効かせる
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

# アプリ本体
COPY index.js ./
COPY scripts ./scripts

# 非 root で実行(node イメージ同梱の node ユーザ)。tmp 作業ディレクトリを用意。
RUN mkdir -p /tmp/wll-work && chown -R node:node /app /tmp/wll-work
USER node

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "index.js"]
