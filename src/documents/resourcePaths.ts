/** Resolve configured paths without depending on the caller's operating system. */
export function resolveResourceUrl(source: string, workspace?: string, home?: string): URL {
  if (!source.trim() || source.includes("\0")) throw Error("文件地址不能为空或包含空字符。")
  let path = source
  if (path.startsWith("~")) {
    if (!/^~(?:[\\/]|$)/u.test(path)) throw Error("路径只支持 ~ 或 ~/，不支持 ~otheruser。")
    if (!home) throw Error("当前环境未提供用户主目录，请使用工作区相对路径或完整文件 URI。")
    path = home.replace(/[\\/]$/u, "") + path.slice(1).replaceAll("\\", "/")
  }
  const encodedPath = (value: string) => value.split("/").map(encodeURIComponent).join("/")
  let url: URL
  if (/^[a-z]:[\\/]/iu.test(path)) {
    path = path.replaceAll("\\", "/")
    url = new URL("file:///" + path[0].toLowerCase() + ":" + encodedPath(path.slice(2)))
  } else if (/^(?:\\\\|\/\/)/u.test(path)) {
    const [host, ...parts] = path.replaceAll("\\", "/").slice(2).split("/")
    if (!host || !parts[0]) throw Error("UNC 路径必须包含服务器和共享目录。")
    url = new URL("file://" + host + "/" + encodedPath(parts.join("/")))
  } else if (/^[a-z][a-z\d+.-]*:/iu.test(path)) {
    if (/^[a-z]:/iu.test(path)) throw Error("Windows 路径必须是绝对路径，例如 C:/data.json。")
    url = new URL(path)
  } else if (path.startsWith("/")) url = new URL("file://" + encodedPath(path))
  else {
    if (!workspace) throw Error("相对路径需要所属工作区，请使用绝对路径或 ~ 路径。")
    url = new URL(encodedPath(path.replaceAll("\\", "/")), workspace.replace(/\/?$/u, "/"))
  }
  if (url.username || url.password || url.hash) throw Error("文件 URI 不允许包含用户名、密码或片段。")
  if (url.protocol === "file:") {
    if (url.search) throw Error("本地文件 URI 不允许包含查询参数。")
    url.pathname = url.pathname.replace(/^\/[A-Z]:/u, (drive) => drive.toLowerCase())
  }
  return url
}
