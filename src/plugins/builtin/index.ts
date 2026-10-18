/** 内置插件登记处：新增一个功能模块 = 这里加一行导入（导入即注册）。 */
// 内核：恒开，不进「打开或关闭功能」（待办 / AI）
import './core'
// 可开关的内容域模块，一个模块一个文件
import './nutrition'
import './ledger'
import './focus'
import './voice'
import './record'
import './sync'
import './sports'
import './campus'
// 课表的子模块（默认关闭）。**必须在 campus 之后导入**：注册表按顺序展示，
// 设置页的父/子分组也依赖父模块已登记。
import './campusGrab'
import './program'
