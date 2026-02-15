FROM mcr.microsoft.com/playwright:v1.58.2-jammy

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install Node.js dependencies
RUN npm ci

# Copy source code
COPY src/ ./src/

# Install only Chromium (used for page reading)
RUN npx playwright install chromium

# Expose port for HTTP API
EXPOSE 3099

# Set environment variable
ENV PORT=3099

# Start the server
CMD ["node", "src/index.js"]
