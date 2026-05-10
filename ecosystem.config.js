module.exports = {
  apps: [{
    name: 'meesho-scan',
    script: 'index.js',
    cwd: './server',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '256M',
    env: {
      NODE_ENV: 'production',
      PORT: 3847,
    },
  }],
};
