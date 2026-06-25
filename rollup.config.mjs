import { readFileSync } from 'fs';

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

/** PlayCanvas ESM vendor（与 import map / src/index.html 中文件名一致） */
const PLAYCANVAS_VENDOR_FILE = 'playcanvas-2.19.2.js';

// 判断是否需要生成完整 package
const isPackageBuild = process.env.BUILD_PACKAGE === 'true';

// 判断是否生成 sourcemap（默认生产环境不生成，可通过 SOURCEMAP=true 启用）
const shouldGenerateSourcemap = process.env.SOURCEMAP === 'true' || process.env.NODE_ENV !== 'production';

// 判断是否启用强混淆（通过环境变量 OBFUSCATE=true 启用）
const shouldObfuscate = process.env.OBFUSCATE === 'true';

// dist 压缩是否移除 console（默认 production 打包移除；KEEP_CONSOLE=true 保留）
const shouldDropConsole =
    process.env.KEEP_CONSOLE !== 'true' &&
    (process.env.NODE_ENV === 'production' || process.env.DROP_CONSOLE === 'true');

// 创建 obfuscator 插件配置（安全模式，避免破坏代码功能）
// 注意：需要先安装 rollup-plugin-obfuscator
// 运行: npm install --save-dev rollup-plugin-obfuscator
const getObfuscatorConfig = () => ({
  // 基础混淆选项（安全模式）
  compact: true, // 压缩代码
  controlFlowFlattening: false, // 禁用控制流扁平化（可能影响性能）
  deadCodeInjection: false, // 禁用死代码注入（可能影响性能）
  debugProtection: false, // 禁用调试保护（可能影响开发）
  disableConsoleOutput: false, // 不禁用 console（已通过 terser 处理）
  
  // 字符串混淆（相对安全）
  stringArray: true, // 启用字符串数组
  stringArrayCallsTransform: false, // 禁用字符串数组调用转换（更安全）
  stringArrayEncoding: [], // 不使用编码（避免兼容性问题）
  stringArrayIndexShift: true, // 字符串数组索引偏移
  stringArrayRotate: true, // 字符串数组旋转
  stringArrayShuffle: true, // 字符串数组洗牌
  stringArrayWrappersCount: 1, // 字符串数组包装器数量
  stringArrayThreshold: 0.75, // 字符串数组阈值
  
  // 标识符混淆（相对安全）
  identifierNamesGenerator: 'hexadecimal', // 标识符名称生成器
  renameGlobals: false, // 不重命名全局变量（避免破坏外部接口）
  renameProperties: false, // 不重命名属性（避免破坏对象属性访问）
  
  // 其他选项
  selfDefending: false, // 禁用自我保护（可能影响性能）
  simplify: true, // 简化代码
  splitStrings: false, // 不分割字符串（避免兼容性问题）
  transformObjectKeys: false, // 不转换对象键（避免破坏对象结构）
  unicodeEscapeSequence: false, // 不使用 Unicode 转义（避免兼容性问题）
  
  // 目标环境
  target: 'browser', // 目标环境：浏览器
});

// 创建 obfuscator 插件（延迟加载，避免未安装时报错）
const createObfuscatorPlugin = () => {
  if (!shouldObfuscate) return null;
  
  // 返回一个包装插件，在运行时加载真正的 obfuscator
  let obfuscatorInstance = null;
  
  return {
    name: 'obfuscator-wrapper',
    async buildStart() {
      if (!obfuscatorInstance) {
        try {
          const obfuscatorModule = await import('rollup-plugin-obfuscator');
          const Obfuscator = obfuscatorModule.default || obfuscatorModule;
          obfuscatorInstance = Obfuscator(getObfuscatorConfig());
          
          // 调用真正的 obfuscator 的 buildStart
          if (obfuscatorInstance && obfuscatorInstance.buildStart) {
            await obfuscatorInstance.buildStart.apply(this, arguments);
          }
        } catch (e) {
          console.warn('⚠️  rollup-plugin-obfuscator 未安装，强混淆功能将不可用。');
          console.warn('   运行: npm install --save-dev rollup-plugin-obfuscator');
          obfuscatorInstance = { transform: () => null }; // 空插件，避免后续错误
        }
      }
    },
    async transform(code, id) {
      if (obfuscatorInstance && obfuscatorInstance.transform) {
        return await obfuscatorInstance.transform.call(this, code, id);
      }
      return null;
    },
    async generateBundle(options, bundle) {
      if (obfuscatorInstance && obfuscatorInstance.generateBundle) {
        return await obfuscatorInstance.generateBundle.call(this, options, bundle);
      }
    }
  };
};

const obfuscatorPlugin = createObfuscatorPlugin();

// --- 清理 dist 文件夹插件 ---
const cleanDistPlugin = () => ({
  name: 'clean-dist',
  buildStart() {
    const distDir = 'dist';
    if (fs.existsSync(distDir)) {
      // 读取 dist 目录下的所有文件
      const files = fs.readdirSync(distDir);
      
      // 删除所有文件
      files.forEach(file => {
        const filePath = path.join(distDir, file);
        const stat = fs.statSync(filePath);
        
        if (stat.isDirectory()) {
          // 如果是目录，递归删除
          fs.rmSync(filePath, { recursive: true, force: true });
          console.log(`🗑️  已删除目录: ${filePath}`);
        } else {
          // 如果是文件，直接删除
          fs.unlinkSync(filePath);
          console.log(`🗑️  已删除文件: ${filePath}`);
        }
      });
      
      console.log(`✅ 已清空 dist 文件夹`);
    } else {
      // 如果 dist 目录不存在，创建它
      fs.mkdirSync(distDir, { recursive: true });
      console.log(`✅ 已创建 dist 文件夹`);
    }
  }
});

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
function htmlPlugin() {
    return {
        name: 'html',
        buildStart() {
            this.addWatchFile('src/index.html');
        },
        generateBundle() {
            const contents = readFileSync('src/index.html', 'utf-8');
            const transformed = contents.replace('<base href="">', `<base href="${process.env.BASE_HREF ?? ''}">`);
            this.emitFile({
                type: 'asset',
                fileName: 'index.html',
                source: transformed
            });
        }
    };
}

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
        }),
        {
            name: 'suppress-empty-chunks',
            generateBundle(options, bundle) {
                for (const [fileName, chunk] of Object.entries(bundle)) {
                    if (chunk.type === 'chunk' && chunk.code.trim() === '') {
                        delete bundle[fileName];
                    }
                }
            }
        }
    ]
};

// --- Public 构建（本地开发预览，不使用 hash） ---
const buildPublic = {
    input: 'src/index.ts',
    external: ['playcanvas'],
    output: {
        dir: 'public',
        format: 'esm',
        sourcemap: true
    },
    plugins: [
        resolve(),
        typescript(),
        json(),
        htmlPlugin()
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
      // 如果不需要 sourcemap，删除所有 sourcemap 文件
      if (!shouldGenerateSourcemap) {
        const distFiles = fs.readdirSync('dist');
        distFiles.forEach(file => {
          if (file.endsWith('.map')) {
            const mapPath = path.join('dist', file);
            fs.unlinkSync(mapPath);
            console.log(`🗑️  已删除 sourcemap: ${file}`);
          }
        });
      }

      // 生产环境删除类型定义文件（保护代码结构）
      if (process.env.NODE_ENV === 'production' && process.env.KEEP_TYPES !== 'true') {
        const dtsPath = 'dist/index.d.ts';
        if (fs.existsSync(dtsPath)) {
          fs.unlinkSync(dtsPath);
          console.log(`🗑️  已删除类型定义文件: index.d.ts (生产环境)`);
        }
      }

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
      sourcemap: shouldGenerateSourcemap, // 通过环境变量 SOURCEMAP 或 NODE_ENV 控制
      entryFileNames: 'index.[hash].js',
    }
  ],
  plugins: [
    cleanDistPlugin(), // 在构建开始时清空 dist 文件夹
    resolve(),
    // NOTE: 仅将源码中的静态文本资源作为字符串引入，避免误处理 node_modules 的 JS（会破坏第三方库的命名导出）
    string({ include: ['src/**/*.html', 'src/**/*.css'], exclude: ['**/node_modules/**'] }),
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
        { src: 'settings.json', dest: 'dist' },
        // 标注热点 SVG 等图标资源，供 dist 产物直接访问 assets/icons/*
        { src: 'public/assets/icons/**/*', dest: 'dist/assets/icons' },
        // 花瓣等纹理图集，供 dist 产物直接访问 assets/textures/*
        { src: 'public/assets/textures/**/*', dest: 'dist/assets/textures' },
        {
          src: `public/vendor/${PLAYCANVAS_VENDOR_FILE}`,
          dest: 'dist/vendor'
        },
        {
          src: 'public/vendor/basis/**/*',
          dest: 'dist/vendor/basis'
        }
      ]
    }),
    terser({
      compress: {
        drop_console: shouldDropConsole,
        drop_debugger: shouldDropConsole,
        pure_funcs: [],
        passes: 2,
      },
      mangle: {
        properties: false, // 不混淆属性名，避免破坏代码功能
        toplevel: false, // 不混淆顶级作用域
        reserved: [], // 保留的变量名列表
      },
      format: {
        comments: false, // 移除注释
      },
      ecma: 2020, // 目标 ECMAScript 版本
    }),
    // 强混淆插件（需要先安装: npm install --save-dev rollup-plugin-obfuscator）
    // 通过环境变量 OBFUSCATE=true 启用
    obfuscatorPlugin,
    distHashPlugin(),
    packagePlugin(),
  ],
};

// --- 导出 ---
// 根据环境变量决定是否生成类型定义文件
const buildConfigs = [buildCss, buildPublic, buildDist];
// 只有在非生产环境或明确要求时才生成类型定义
if (process.env.NODE_ENV !== 'production' || process.env.GENERATE_TYPES === 'true') {
  buildConfigs.push(buildTypes);
}

export default buildConfigs;
