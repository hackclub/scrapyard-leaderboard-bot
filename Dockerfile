# Use the official Bun image with specific version 1.2
FROM oven/bun:1.2

# Set working directory
WORKDIR /app

# Copy package.json and install dependencies
COPY package.json .
RUN bun install --production

# Copy application code
COPY index.js .

# Run as non-root user
USER bun

# Start the application
CMD ["bun", "run", "index.js"] 