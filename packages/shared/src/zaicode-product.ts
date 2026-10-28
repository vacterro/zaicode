/**
 * ZAICODE 产品元数据的唯一来源（handoff M3）。
 *
 * 产品名、上游身份与上游仓库地址只在此声明；UI、服务与文档从该模块读取，
 * 不允许在业务代码里散落 "ZAICODE" / 上游名称字符串。内部包名、协议标识、
 * 环境变量与 RPC 名保持上游兼容，不做装饰性改名。
 */
export const ZAICODE_PRODUCT_ID = "zaicode";

/** 产品显示名（唯一来源）。 */
export const ZAICODE_PRODUCT_DISPLAY_NAME = "ZAICODE";

/** 上游身份声明：产品派生自 ZCode，署名与许可证义务随上游保留。 */
export const ZAICODE_UPSTREAM_DISPLAY_NAME = "ZCode by Z.ai";

export const ZAICODE_UPSTREAM_REPOSITORY_URL = "https://github.com/zai-org/ZCode";

/** ZAICODE 产品能力开关；未列出的能力按上游默认行为。 */
export interface ZaicodeProductCapabilities {
  /** 无强制应用账户：无任何 Provider 时工作区仍可用。 */
  readonly accountFreeWorkspace: boolean;
  /** 操作员可见的 agent 定义层。 */
  readonly agentDefinitions: boolean;
  /** 操作员可见的持久任务队列。 */
  readonly jobQueue: boolean;
  /** 有界编排探针（Coordinator → worker），不做递归派生。 */
  readonly boundedOrchestration: boolean;
}

export interface ZaicodeProductMetadata {
  readonly productId: string;
  readonly displayName: string;
  readonly upstream: {
    readonly displayName: string;
    readonly repositoryUrl: string;
  };
  readonly capabilities: ZaicodeProductCapabilities;
}

export function getZaicodeProductMetadata(): ZaicodeProductMetadata {
  return {
    productId: ZAICODE_PRODUCT_ID,
    displayName: ZAICODE_PRODUCT_DISPLAY_NAME,
    upstream: {
      displayName: ZAICODE_UPSTREAM_DISPLAY_NAME,
      repositoryUrl: ZAICODE_UPSTREAM_REPOSITORY_URL,
    },
    capabilities: {
      accountFreeWorkspace: true,
      agentDefinitions: true,
      jobQueue: true,
      boundedOrchestration: true,
    },
  };
}
