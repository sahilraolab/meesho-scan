// PM2 ecosystem config — run: pm2 start ecosystem.config.js
module.exports = {
  apps: [
    {
      name:         'meesho-scan',
      script:       'index.js',
      cwd:          '/var/www/meesho-scan/server',
      env_production: {
        NODE_ENV: 'production',
      },
      // Restart if memory exceeds 300 MB
      max_memory_restart: '300M',
      // Keep logs
      out_file:  '/var/log/meesho-scan/out.log',
      error_file:'/var/log/meesho-scan/err.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
  ],
};
