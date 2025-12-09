import json from '@rollup/plugin-json';
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
import path from 'path';
import dts from 'rollup-plugin-dts';
import crypto from 'crypto';

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
    pkg.main = 'dist/index.js';
    pkg.types = 'dist/index.d.ts';
    pkg.private = false;

    fs.writeFileSync('build-package/package.json', JSON.stringify(pkg, null, 2));

    // 4️⃣ 安装依赖
    console.log('📦 安装依赖到 build-package...');
    execSync('cd build-package && npm install --production', { stdio: 'inherit' });

    console.log('✅ 完整 package 构建完成：build-package/');
  },
});

// --- CSS 构建（public 目录，不使用 hash） ---
const buildCss = {
    input: 'src/index.scss',
    output: {
        dir: 'public'
    },
    plugins: [
        scss({
            exclude: ['static/**/*'],
            fileName: 'index.css',
            sourceMap: true,
            runtime: sass,
            processor: (css) => {
                return postcss([autoprefixer])
                .process(css, { from: undefined })
                .then(result => result.css);
            }
        })
    ]
};

// --- Public 构建（本地开发预览，不使用 hash） ---
const buildPublic = {
    input: 'src/index.ts',
    output: {
        dir: 'public',
        format: 'esm',
        sourcemap: true
    },
    plugins: [
        resolve(),
        typescript(),
        json(),
        copy({
            targets: [{
                src: 'src/index.html',
                dest: 'public',
                transform: (contents) => {
                    return contents.toString().replace('<base href="">', `<base href="${process.env.BASE_HREF ?? ''}">`);
                }
            }]
        })
    ]
};

const input = process.env.INPUT || 'src/index.ts';

const buildTypes = {
  input,
  output: {
    file: "dist/index.d.ts",
    format: "esm",
  },
  plugins: [dts()]
};

// 插件：为 dist 生成带 hash 的文件并清理旧文件
const distHashPlugin = () => {
  let distJsFileName = '';
  let distCssFileName = '';
  
  return {
    name: 'dist-hash',
    generateBundle(options, bundle) {
      // 获取生成的 JS 文件名（带 hash）
      const jsFile = Object.keys(bundle).find(name => name.endsWith('.js') && !name.endsWith('.map') && name.includes('.'));
      if (jsFile) {
        distJsFileName = jsFile;
      }
    },
    writeBundle() {
      // 删除不带 hash 的 JS 文件
      const filesToRemove = [
        'dist/index.js',
        'dist/index.js.map',
        'dist/index.min.js'
      ];
      
      filesToRemove.forEach(file => {
        if (fs.existsSync(file)) {
          fs.unlinkSync(file);
          console.log(`🗑️  已删除: ${file}`);
        }
      });

      // 处理 CSS：从 public 复制并生成 hash
      const publicCssPath = 'public/index.css';
      if (fs.existsSync(publicCssPath)) {
        const cssContent = fs.readFileSync(publicCssPath, 'utf-8');
        const hash = crypto.createHash('md5').update(cssContent).digest('hex').slice(0, 8);
        distCssFileName = `index.${hash}.css`;
        const distCssPath = `dist/${distCssFileName}`;
        
        // 复制 CSS 到 dist 并重命名
        fs.writeFileSync(distCssPath, cssContent);
        console.log(`✅ 已生成 dist CSS: ${distCssFileName}`);
        
        // 删除旧的 index.css
        if (fs.existsSync('dist/index.css')) {
          fs.unlinkSync('dist/index.css');
          console.log(`🗑️  已删除: dist/index.css`);
        }
      }

      // 更新 dist/index.html
      const htmlPath = 'dist/index.html';
      
      if (fs.existsSync(htmlPath)) {
        let html = fs.readFileSync(htmlPath, 'utf-8');
        
        // 更新 JS 引用
        if (distJsFileName) {
          html = html.replace(/from ['"]\.\/index\.js['"]/g, `from './${distJsFileName}'`);
          console.log(`✅ 已更新 dist/index.html JS 引用: ${distJsFileName}`);
        }
        
        // 更新 CSS 引用
        if (distCssFileName) {
          html = html.replace(/href=['"]\.\/index\.css['"]/g, `href='./${distCssFileName}'`);
          console.log(`✅ 已更新 dist/index.html CSS 引用: ${distCssFileName}`);
        }
        
        fs.writeFileSync(htmlPath, html);
      }
    }
  };
};

// --- Dist 构建（模块发布用 - 完整导出版本） ---
const buildDist = {
  input: input,
  external: ['playcanvas'],
  output: [
    // 只生成带 hash 的版本
    {
      dir: 'dist',
      format: 'esm',
      sourcemap: true,
      entryFileNames: 'index.[hash].js',
    }
  ],
  plugins: [
    resolve(),
    string({ include: ['**/*.html', '**/*.css', '**/*.js'] }),
    typescript({
      declaration: false,
      declarationMap: false,
    }),
    json(),
    copy({
      targets: [
        {
          src: 'src/index.html',
          dest: 'dist',
          transform: (contents) =>
            contents.toString().replace('<base href="">', `<base href="${process.env.BASE_HREF ?? ''}">`)
        },
        { src: 'settings.json', dest: 'dist'}
      ]
    }),
    distHashPlugin(),
    packagePlugin(),
  ],
};

// --- 导出 ---
export default [buildCss, buildPublic, buildDist, buildTypes];
