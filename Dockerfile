FROM node:20-bookworm

# Install Python3 + pip
RUN apt-get update && apt-get install -y \
    python3 python3-pip \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Install tsx globally so `npx tsx` resolves without network
RUN npm install -g tsx

WORKDIR /app

# Install Node dependencies (includes devDeps for TypeScript/ts-node)
COPY package*.json ./
RUN npm install

# Install Python dependencies
COPY requirements.txt ./
RUN pip3 install --break-system-packages -r requirements.txt

# Install Playwright Chromium + system dependencies for Python
RUN python3 -m playwright install --with-deps chromium

# Copy the rest of the source
COPY . .

EXPOSE 3000

CMD ["npm", "run", "server"]
