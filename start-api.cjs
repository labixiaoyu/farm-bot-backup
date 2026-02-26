// 由于项目使用了TypeScript，我们需要使用tsx或ts-node来运行TypeScript文件
// 让我们尝试使用npx来运行tsx

const { execSync } = require('child_process');

try {
  console.log('正在启动后端API服务器...');
  // 尝试使用npx来运行tsx，添加--yes参数自动确认安装
  execSync('npx --yes tsx src/main.ts --api', { stdio: 'inherit' });
} catch (error) {
  console.error('启动后端API服务器失败:', error.message);
  console.log('尝试使用其他方法启动后端API服务器...');
  
  // 如果tsx不可用，尝试使用ts-node
  try {
    execSync('npx ts-node src/main.ts --api', { stdio: 'inherit' });
  } catch (error) {
    console.error('使用ts-node启动后端API服务器失败:', error.message);
    console.log('请安装tsx或ts-node，然后重试');
    console.log('安装命令: npm install -g tsx');
  }
}
