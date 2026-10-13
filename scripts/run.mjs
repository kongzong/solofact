// 子进程工具，三个 pack 脚本共用：跑真实入口（build.js / esbuild / CLI 体检），
// 非零退出即带着输出抛错——发布链上任何一环哑火都不许静默通过。
import { execFile } from 'node:child_process';

export function run(cmd, args, { cwd = process.cwd() } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      const out = `${stdout}${stderr}`.trim();
      if (err) {
        reject(new Error(`命令失败：${cmd} ${args.join(' ')}\n${out}`));
      } else {
        resolve(out);
      }
    });
  });
}

// 系统命令存在性检测（zip/tar 是本项目唯二的外部构建依赖，缺失时给人话提示）。
export async function hasCmd(cmd) {
  try {
    await run('which', [cmd]);
    return true;
  } catch {
    return false;
  }
}
