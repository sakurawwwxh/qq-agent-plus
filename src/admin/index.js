// 单进程管理员服务注册表。
//
// 不把 admin 塞进 Orchestrator 的 ctx：orchestrator.js 正卡在行数闸门上，而工具只需要
// 在 execute 时拿到同一个单例。app 启动时 createAdminServices() 注册，测试可注入假实现。
let current = null;

export function setAdminServices(services) {
  current = services;
}

export function getAdminServices() {
  return current;
}

export function clearAdminServices() {
  current = null;
}
