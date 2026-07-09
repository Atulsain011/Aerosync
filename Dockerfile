# Use a lightweight Node.js base image
FROM node:20-alpine

# Set the working directory inside the container
WORKDIR /app

# Copy package configurations
COPY package*.json ./

# Install only production dependencies
RUN npm ci --only=production

# Copy backend source and frontend assets
COPY backend/ ./backend/
COPY frontend/ ./frontend/

# Expose the binding port (default: 5000)
EXPOSE 5000

# Set environment variables
ENV NODE_ENV=production
ENV PORT=5000

# Start command
CMD ["node", "backend/src/server.js"]
