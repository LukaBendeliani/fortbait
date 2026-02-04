# Use Node.js as the base image
FROM node:20-slim

# Set working directory
WORKDIR /app

# Copy package files
COPY package.json package-lock.json* ./

# Install dependencies
RUN npm install

# Copy source code
COPY . .

# Expose the signaling port (Railway will override with PORT env var)
EXPOSE 9208

# Start the server using tsx to run TypeScript directly
CMD ["npm", "run", "start"]
