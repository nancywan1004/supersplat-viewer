import * as OSSBrowserModule from 'ali-oss/dist/aliyun-oss-sdk.js';

//#region 环境配置
type DeployEnv = 'test' | 'prod';

type EnvConfig = {
    apiHost: string;
    uploadedFileHost: string;
    // viewerHost: string;
};
// 测试环境域名
const TEST_ENV_CONFIG: EnvConfig = {
    apiHost: 'https://unicity3dev-api.bdnrc.org.cn',
    uploadedFileHost: 'https://unicity-dev2.bdnrc.org.cn',
    // viewerHost: 'https://universe-dev.bdnrc.org.cn/gs?projectId='
};

// 生产环境域名
const PROD_ENV_CONFIG: EnvConfig = {
    apiHost: 'https://unicity3-api.bdnrc.org.cn',   //待确认
    uploadedFileHost: 'https://unicity-model-cdn.bdnrc.org.cn',
    // viewerHost: 'https://universe.bdnrc.org.cn/gs?projectId='
};

const resolveDeployEnv = (): DeployEnv => {
    const host = window.location.hostname.toLowerCase();
    return (host.includes('localhost') || host.includes('127.0.0.1') || host.includes('dev')) ? 'test' : 'prod';
};

const CURRENT_ENV = resolveDeployEnv();
const ENV_CONFIG = CURRENT_ENV === 'prod' ? PROD_ENV_CONFIG : TEST_ENV_CONFIG;
const API_HOST = ENV_CONFIG.apiHost;
const UPLOADED_FILE_HOST = ENV_CONFIG.uploadedFileHost;
// export const VIEWER_HOST = ENV_CONFIG.viewerHost;
//#endregion

export const SPLATFILENAME='point_cloud.splat',SOGFILENAME='point_cloud.sog',SETTINGFILENAME='settings.json';

const UPDATE_PROJECT_DATA="/app/api/v1/project/version/create";   //post 更新项目文件
//const GET_PRIGINAL_DATA="/app/api/v1/project/version/";  //get  {projectId}/original  获取初始版本模型文件
const GET_SINGLE_STSTOKEN="/oss/api/v1/oss/ststoken";  //post 单文件上传临时凭证
const GET_MULTIPART_STSTOKEN="/oss/api/v1/oss/multipart/init" ; //post 大文件上传临时凭证
const CHUNKSIZE=10485760;  //分片大小 10M
const OSSClientCtor = OSSBrowserModule as unknown as { default?: new (...args: any[]) => any } | (new (...args: any[]) => any);

type UniverseAuthContext = {
    token?: string;
};

let universeAuthContext: UniverseAuthContext = {};

const setUniverseAuthContext = (context: UniverseAuthContext) => {
    universeAuthContext = {
        ...universeAuthContext,
        ...context
    };
};

const getToken = () => {
    return universeAuthContext.token ?? '';
};

//#region 日志打印
const UNICITY_LOG =  CURRENT_ENV === 'prod' ? false : true;

const logApi = (
    method: 'GET' | 'POST',
    url: string,
    requestBody: unknown | undefined,
    responseBody: unknown
) => {
    if (!UNICITY_LOG) return;
    console.log('[3dgs editor api]', { method, url, requestBody, responseBody });
};
//#endregion

//#region 接口请求体、返回体
/**
 * 更新的文件类型
 */
 enum UpdateFileType {
    GSMODEL = 'model',  //仅GS或 GS和settings
    SETTINGS = 'setting'
};
/**
 * 更新项目文件-request
 */
type UpdateProjectRequest = {
    files: UploadFile[];
    projectId: number;
    type: string;   
};
type UpdateProjectResponse = {
    code: number;
    data: number | null;
    message: string;
};

/**
 * 上传的文件类型
 */
type UploadFile = {
    fileName: string;
    fileSize: number;
    fileType: 'MODEL';
    fileUrl: string;
};
/**
 * 获取项目原始数据-response
 */
type GetProjectData_Response={
    code: number;
    data: {
        fileName: string;
        fileType: string;
        fileUrl: string;
    }[];
    message: string;
};
/**
 * 获取单文件上传临时凭证-request
 */
type Single_STSTOKEN_Request={
    fileSize: number;
    type:number;  //1-物体  2-场景
    fileName: string;
}
/**
 * 获取单文件上传临时凭证-response
 */
type Single_STSTOKEN_Response={
    code: number;
    data: {
        accessKeyId: string;
        accessKeySecret: string;
        securityToken: string;
        objectKey: string;
        ossEndpoint: string;
        bucket: string;
        uploadId: string;
        region: string;
        expireAt:number;
    };
    message: string;
}
/**
 * 获取大文件分片上传临时凭证-request
 */
type Multipart_STSTOKEN_Request={
    fileSize: number;
    type:number;  //1-物体  2-场景
    fileName: string;
    uploadId:string;  //续传时使用；
    chunkSize:number;
}
/**
 * 获取大文件分片上传临时凭证-response
 */
type Multipart_STSTOKEN_Response={
    code: number;
    data: {
        accessKeyId: string;
        accessKeySecret: string;
        securityToken: string;
        objectKey: string;
        ossEndpoint: string;
        bucket: string;
        uploadId: string;
        region: string;
        expireAt:number;
        uploadedParts:number[];
        chunkSize:number;
    };
    message: string;
}

//#endregion

//#region 更新项目文件
/**
 * 更新模型文件新版本
 * 流程：上传阿里云 -> 组装 files 请求体 -> 调用接口
 * @param projectId 项目ID
 * @param inputFiles 支持单文件或最多两个文件
 * @returns 是否更新成功（code === 1）
 */
export const updateProjectData = async (projectId: number | string, inputFiles: File | File[]): Promise<boolean> => {
    const files = Array.isArray(inputFiles) ? inputFiles : [inputFiles];

    if (files.length === 0) {
        throw new Error('至少需要传入一个文件');
    }
    if (files.length > 2) {
        throw new Error('最多支持两个文件');
    }

    try {
        const uploadResults = await Promise.all(
            files.map((file) => uploadFileToAliyun(file, 2, projectId))
        );

        const payloadFiles: UploadFile[] = files.map((file, index) => ({
            fileName: file.name,
            fileSize: file.size,
            fileType: 'MODEL',
            fileUrl: uploadResults[index].fileUrl
        }));

        const isOnlySingleSettingsFile =
            files.length === 1 && files[0].name.toLowerCase() === SETTINGFILENAME;

        const requestBody: UpdateProjectRequest = {
            files: payloadFiles,
            projectId: Number(projectId),
            // 仅“有且仅有一个 settings.json 文件”走 setting，其余全部走 model
            type: isOnlySingleSettingsFile ? UpdateFileType.SETTINGS : UpdateFileType.GSMODEL
        };

        const response = await postProjectData(requestBody);
        return response.code === 1;
    } catch (error) {
        console.error('更新模型版本失败:', error);
        return false;
    }
};

/**
 * 上传项目 settings.json（仅单文件）。
 * 会强制使用统一文件名 settings.json，接口 type 会自动走 setting。
 */
export const uploadProjectData = async (
    projectId: number | string,
    token: string,
    settingsJson: string | object
): Promise<boolean> => {
    if (projectId == null || projectId === '') {
        console.error('uploadProjectData 缺少 projectId');
        return false;
    }
    if (!token) {
        console.error('uploadProjectData 缺少 token');
        return false;
    }

    setUniverseAuthContext({ token });
    const jsonString = typeof settingsJson === 'string' ? settingsJson : JSON.stringify(settingsJson, null, 2);
    const settingsFile = new File([jsonString], SETTINGFILENAME, { type: 'application/json' });
    return updateProjectData(projectId, settingsFile);
};

/**
 * 调更新文件接口
 */
const postProjectData = async (payload: UpdateProjectRequest): Promise<UpdateProjectResponse> => {
    const url = `${API_HOST}${UPDATE_PROJECT_DATA}`;
    return await fetchCloudJsonPost<UpdateProjectResponse>(url, payload);
};

//#endregion

//#region 阿里云 OSS 上传
/**
 * 上传结果
 */
export type OssUploadResult = {
    fileName: string;
    fileSize: number;
    fileUrl: string;
};

/**
 * 发送 POST 请求到云端
 * @param url 请求的 URL
 * @param body 请求的 body
 * @returns 返回解析后的 JSON 数据
 */
const fetchCloudJsonPost = async <TResponse>(
    url: string,
    body: unknown
): Promise<TResponse> => {
    let response: Response;
    try {
        response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': getToken() ?? ''
            },
            body: JSON.stringify(body)
        });
    } catch (error) {
        logApi('POST', url, body, { error: String(error) });
        throw error;
    }

    if (!response.ok) {
        let text = '';
        try {
            text = await response.text();
        } catch {
            // ignore
        }
        logApi('POST', url, body, { status: response.status, text });
        throw new Error(`请求失败，状态码: ${response.status}`);
    }

    const json = await response.json() as TResponse;
    logApi('POST', url, body, json);
    return json;
};

const getSingleStsToken = async (payload: Single_STSTOKEN_Request): Promise<Single_STSTOKEN_Response['data']> => {
    const url = `${API_HOST}${GET_SINGLE_STSTOKEN}`;
    const response = await fetchCloudJsonPost<Single_STSTOKEN_Response>(url, payload);
    const isSuccess = response.code === 200 || response.code === 1;
    if (!isSuccess || !response.data) {
        console.error('获取单文件上传临时凭证失败:', {
            code: response.code,
            message: response.message
        });
        throw new Error(response.message || '获取单文件上传临时凭证失败');
    }
    return response.data;
};

const getMultipartStsToken = async (payload: Multipart_STSTOKEN_Request): Promise<Multipart_STSTOKEN_Response['data']> => {
    const url = `${API_HOST}${GET_MULTIPART_STSTOKEN}`;
    const response = await fetchCloudJsonPost<Multipart_STSTOKEN_Response>(url, payload);
    // 兼容后端：有的接口 code=200，有的接口 code=1 表示成功
    const isSuccess = response.code === 200 || response.code === 1;
    if (!isSuccess || !response.data) {
        console.error('获取分片上传临时凭证失败:', {
            code: response.code,
            message: response.message
        });
        throw new Error(response.message || '获取分片上传临时凭证失败');
    }
    return response.data;
};

const normalizeEndpoint = (endpoint: string) => {
    return endpoint.replace(/^https?:\/\//, '');
};

const createOssClient = (sts: Single_STSTOKEN_Response['data'] | Multipart_STSTOKEN_Response['data']) => {
    // ali-oss 在不同打包器/导出形态下可能是：
    // - 直接导出构造函数（typeof === 'function'）
    // - 或者是 module namespace（需要取 .default / .OSS）
    const ossAny = OSSClientCtor as any;
    // UMD 可能会把构造函数挂到全局
    const globalOss = (globalThis as any)?.OSS;
    const candidates: unknown[] = [ossAny, ossAny?.default, ossAny?.OSS, globalOss];
    const Ctor = candidates.find((c) => typeof c === 'function') as
        | (new (options: any) => any)
        | undefined;

    if (!Ctor) {
        // 无论 debug 开不打开，都打印关键类型信息（避免你排查时没有线索）
        console.error('[unicity] OSS ctor resolve failed', {
            typeofOSSClientCtor: typeof ossAny,
            hasDefault: !!ossAny?.default,
            hasOSS: !!ossAny?.OSS,
            typeofGlobalOSS: typeof globalOss,
            globalOSSHasPut: !!(globalOss && (globalOss as any).prototype?.put)
        });
        throw new Error('ali-oss constructor resolve failed');
    }

    return new Ctor({
        region: sts.region,
        accessKeyId: sts.accessKeyId,
        accessKeySecret: sts.accessKeySecret,
        stsToken: sts.securityToken,
        bucket: sts.bucket,
        endpoint: normalizeEndpoint(sts.ossEndpoint),
        secure: true
    });
};

const buildUploadedFileUrl = (objectKey: string) => {
    const base = UPLOADED_FILE_HOST.replace(/\/+$/, '');
    const key = objectKey.replace(/^\/+/, '');
    return `${base}/${key}`;
};

/**
 * settings 文件上传时，强制对象名尾部为 settings.json，避免时间戳命名影响识别。
 */
const resolveUploadObjectKey = (objectKey: string, fileName: string, projectId?: number | string) => {
    if (fileName.toLowerCase() !== SETTINGFILENAME) return objectKey;
    const normalizedProjectId = String(projectId ?? '').trim();
    const key = objectKey.replace(/^\/+/, '');
    const slashIndex = key.lastIndexOf('/');
    const baseDir = slashIndex >= 0 ? key.slice(0, slashIndex + 1) : '';
    if (!normalizedProjectId) return `${baseDir}${SETTINGFILENAME}`;
    return `${baseDir}${normalizedProjectId}/${SETTINGFILENAME}`;
};

const uploadSingleToOss = async (file: File, sts: Single_STSTOKEN_Response['data'], projectId?: number | string) => {
    const client = createOssClient(sts);
    const targetObjectKey = resolveUploadObjectKey(sts.objectKey, file.name, projectId);
    const result = await client.put(targetObjectKey, file, {
        mime: file.type || 'application/octet-stream'
    });
    if (!result?.url) {
        throw new Error('单文件上传失败: 未返回文件URL');
    }
    return targetObjectKey;
};

/**
 * 上传文件到阿里云 OSS。
 * 自动按文件大小选择：小文件走单文件上传，大文件走分片上传。
 * @param file 需要上传的文件
 * @param type 文件类型（1-物体，2-场景）
 */
export const uploadFileToAliyun = async (file: File, type = 2, projectId?: number | string): Promise<OssUploadResult> => {
    if (!file) {
        throw new Error('文件不能为空');
    }

    const isLargeFile = file.size > CHUNKSIZE;

    // 小文件（<=10MB）：请求单文件临时凭证并上传
    if (!isLargeFile) {
        const sts = await getSingleStsToken({
            fileSize: file.size,
            type,
            fileName: file.name
        });

        const uploadedObjectKey = await uploadSingleToOss(file, sts, projectId);
        return {
            fileName: file.name,
            fileSize: file.size,
            fileUrl: buildUploadedFileUrl(uploadedObjectKey),
        };
    }

    // 大文件（>10MB）：请求分片临时凭证并分片上传
    const multipartSts = await getMultipartStsToken({
        fileSize: file.size,
        type,
        fileName: file.name,
        uploadId: '',
        chunkSize: CHUNKSIZE
    });

    const client = createOssClient(multipartSts);
    const targetObjectKey = resolveUploadObjectKey(multipartSts.objectKey, file.name, projectId);
    await client.multipartUpload(targetObjectKey, file, {
        partSize: multipartSts.chunkSize || CHUNKSIZE
    });
    return {
        fileName: file.name,
        fileSize: file.size,
        fileUrl: buildUploadedFileUrl(targetObjectKey),
    };
};

//#endregion

