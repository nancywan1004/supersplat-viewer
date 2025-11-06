import resolve from '@rollup/plugin-node-resolve';
import typescript from '@rollup/plugin-typescript';
import autoprefixer from 'autoprefixer';
import postcss from 'postcss';
import copy from 'rollup-plugin-copy';
import scss from 'rollup-plugin-scss';
import { string } from 'rollup-plugin-string';
import sass from 'sass';
import terser from '@rollup/plugin-terser';
import { execSync } from 'child_process';
import fs from 'fs';

// 判断是否需要生成完整 package
const isPackageBuild = process.env.BUILD_PACKAGE === 'true';

// --- 可选的 Package 构建逻辑（改成 Rollup 插件形式） ---
const packagePlugin = () => ({
  name: 'build-package',
  writeBundle() {
    if (!isPackageBuild) return;

    console.log('🧰 开始构建完整 package...');
    execSync('rm -rf build-package && mkdir build-package');

    // 1️⃣ 复制 dist
    execSync('cp -r dist build-package/');

    // 2️⃣ 复制 README.md（若存在）
    if (fs.existsSync('README.md')) {
      execSync('cp README.md build-package/');
    }

    // 3️⃣ 复制并调整 package.json
    const pkg = JSON.parse(fs.readFileSync('package.json', 'utf-8'));
    delete pkg.devDependencies;
    pkg.main = 'dist/index.min.js';
    pkg.types = 'dist/index.d.ts';
    pkg.private = false;

    fs.writeFileSync('build-package/package.json', JSON.stringify(pkg, null, 2));

    // 4️⃣ 安装依赖
    console.log('📦 安装依赖到 build-package...');
    execSync('cd build-package && npm install --production', { stdio: 'inherit' });

    console.log('✅ 完整 package 构建完成：build-package/');
  },
});

// --- CSS 构建 ---
const buildCss = {
  input: 'src/index.scss',
  output: { dir: 'public' },
  plugins: [
    scss({
      exclude: ['static/**/*'],
      fileName: 'index.min.css',
      sourceMap: false,
      runtime: sass,
      outputStyle: 'compressed',
      processor: (css) =>
        postcss([autoprefixer])
          .process(css, { from: undefined })
          .then((result) => result.css),
    }),
  ],
};

// --- Public 构建 ---
const buildPublic = {
  input: 'src/index.ts',
  output: { dir: 'public', format: 'esm', sourcemap: false },
  plugins: [
    resolve(),
    typescript(),
    copy({
      targets: [
        {
          src: 'src/index.html',
          dest: 'public',
          transform: (contents) =>
            contents
              .toString()
              .replace('<base href="">', `<base href="${process.env.BASE_HREF ?? ''}">`),
        },
      ],
    }),
  ],
};

// --- Dist 构建（模块发布用） ---
const buildDist = {
  input: 'src/module/index.ts',
  external: ['playcanvas'],
  output: {
    file: 'dist/index.min.js',
    format: 'esm',
    sourcemap: false,
  },
  plugins: [
    resolve(),
    string({ include: ['**/*.html', '**/*.css', '**/*.js'] }),
    typescript(),
    terser(),
    copy({
      targets: [{ src: 'src/module/index.d.ts', dest: 'dist' }],
    }),
    packagePlugin(),
  ],
};

// --- 导出 ---
export default [buildCss, buildPublic, buildDist];
