package com.gozaoo.rein

import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.result.ActivityResultLauncher
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.PermissionController
import androidx.health.connect.client.records.DistanceRecord
import androidx.health.connect.client.records.ExerciseSessionRecord
import androidx.health.connect.client.records.HeartRateRecord
import androidx.health.connect.client.records.Record
import androidx.health.connect.client.records.TotalCaloriesBurnedRecord
import androidx.health.connect.client.records.metadata.DataOrigin
import androidx.health.connect.client.records.metadata.Metadata
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.time.TimeRangeFilter
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.time.Instant
import java.time.ZoneId
import java.time.ZoneOffset
import kotlin.reflect.KClass

/**
 * Rust(JNI) ↔ Kotlin 的 Health Connect 桥。**只做 HC 的读/写/授权**，
 * 不懂 Rein 的业务字段 —— 两侧语义的翻译全在 Rust 的 modules/healthsync/adapter.rs。
 *
 * 为什么数据走文件而不是 JNI 返回值：`jni_handle().exec` 是发后不管的，
 * 而 HC 的读写在协程里完成，结果不可能在调用栈里返回。所以沿用分享收件箱
 * （ShareReceiver）那套：本桥把结果写进 `cacheDir` 下的 `health_sync` 目录里，
 * Rust 读同一个目录。JNI 只用来下达指令。
 *
 * （注意别在这个块注释里写通配路径：Kotlin 的块注释**可以嵌套**，
 * 「目录名斜杠星号」会被当成开了一个新的注释，然后整个文件都成了注释。）
 *
 * 文件即信号（这点很重要）：Rust 在发起操作**之前**先删掉对应的结果文件，
 * 然后「文件出现」就等于「这次操作成功了」。所以：
 * - 只有成功才写结果文件（失败只写 state.json 的 error，Rust 据此立刻收场，
 *   不必等超时）；
 * - 每次开始新操作先把上一次的 error 清掉。
 *
 * 授权：HC 的权限**没有**系统运行时弹窗那条路，只能在 HC 自己的界面上授予，
 * 所以这里注册 `PermissionController.createRequestPermissionResultContract()`。
 * 那个 launcher 必须在 Activity 创建时注册（见 MainActivity.onCreate）。
 */
object HealthConnectBridge {
  private const val TAG = "HealthConnectBridge"
  private const val SELF_PACKAGE = "com.gozaoo.rein"

  private const val DIR = "health_sync"
  private const val STATE_FILE = "state.json"
  private const val PULL_FILE = "pull.json"
  private const val PUSH_REQUEST_FILE = "push-request.json"
  private const val PUSH_RESULT_FILE = "push-result.json"

  /** 数据起点：读「有记录以来」。HC 里不可能有 2000 年以前的运动记录。 */
  private val EPOCH: Instant = Instant.parse("2000-01-01T00:00:00Z")

  /**
   * 读权限：运动会话 + 配它用的三类记录。
   *
   * 直接写权限串而不是 `HealthPermission.getReadPermission(KClass)`：
   * 常量值就是 `android.permission.health.READ_<RECORD>`（HC 的 PERMISSION_PREFIX
   * + 记录类型名），小米运动健康在它的清单里声明的也是这几个同名字符串，
   * 写死比多引一层 API 更清楚。
   */
  private val READ_PERMS =
    setOf(
      "android.permission.health.READ_EXERCISE",
      "android.permission.health.READ_TOTAL_CALORIES_BURNED",
      "android.permission.health.READ_DISTANCE",
      "android.permission.health.READ_HEART_RATE",
    )

  private val WRITE_PERMS = setOf("android.permission.health.WRITE_EXERCISE")

  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
  private val main = Handler(Looper.getMainLooper())

  /** HC 授权界面的 launcher（Activity 创建时注册） */
  private var launcher: ActivityResultLauncher<Set<String>>? = null

  /** MainActivity.onCreate 调用一次 */
  fun register(activity: ComponentActivity) {
    launcher =
      activity.registerForActivityResult(
        PermissionController.createRequestPermissionResultContract()
      ) {
        // 用户从 HC 界面回来了：立刻重算一遍授权状态写进 state.json
        Log.i(TAG, "授权页返回")
        scope.launch { writeState(activity.applicationContext) }
      }
    Log.i(TAG, "register 完成")
  }

  /* ---------------- 指令入口（Rust 经 JNI 调这些） ---------------- */

  /** 重算可用性与授权，写 state.json */
  // @JvmStatic 是必须的：Rust 侧用 call_static_method 按名字找方法，
  // 而 Kotlin object 的成员默认是**单例上的实例方法**（要经 INSTANCE 调用）。
  // 漏掉的后果实测过一次：NoSuchMethodError 抛在主线程 → 点开这一页就闪退。
  @JvmStatic
  fun refresh(context: Context) {
    val app = context.applicationContext
    scope.launch { writeState(app) }
  }

  /** 拉起 HC 的授权页。mode = "write" 时连写权限一起要。 */
  @JvmStatic
  fun requestPermissions(context: Context, mode: String) {
    val app = context.applicationContext
    val wanted = if (mode == "write") READ_PERMS + WRITE_PERMS else READ_PERMS
    Log.i(TAG, "requestPermissions(mode=$mode, perms=${wanted.size}, launcher=${launcher != null})")
    main.post {
      val l = launcher
      if (l == null) {
        // 理论不可达（register 在 onCreate 里）。写入原因让前端能给出可操作的提示。
        Log.w(TAG, "授权 launcher 为空，register 没有执行过")
        scope.launch {
          writeState(app, error = "授权入口未就绪，请重开应用")
        }
        return@post
      }
      try {
        l.launch(wanted)
        Log.i(TAG, "已发起 HC 授权页")
      } catch (e: Exception) {
        Log.e(TAG, "发起授权失败，退回 HC 设置页", e)
        // 兜底：直接打开 Health Connect 自己的设置页，用户在那里也能把权限授予 Rein。
        // 为什么值得有这条：授权弹窗是 HC 模块在系统侧生成的 intent，各家 ROM 上
        // 能解析到什么程度不一致 —— 有兜底就不会出现「点了没反应」这种最糟的结果。
        val opened = openHealthConnectSettings(app)
        scope.launch {
          writeState(
            app,
            error = if (opened) null else "无法打开健康数据授权页：${e.message}",
          )
        }
      }
    }
  }

  /**
   * 打开系统的 Health Connect 设置页（授权弹窗拉不起来时的兜底落点）。
   *
   * 这里用字面量 action 而不是库里的 `getHealthConnectSettingsAction()`：
   * 这个串在目标机型上**实测能解析**（落到 `com.android.healthconnect.controller/
   * .navigation.TrampolineActivity`），而成员名在同一版本里叫法不一，
   * 有实测值就别去赌 API 名。
   */
  private fun openHealthConnectSettings(context: Context): Boolean =
    try {
      context.startActivity(
        Intent("android.health.connect.action.HEALTH_HOME_SETTINGS")
          .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      )
      Log.i(TAG, "已打开 HC 设置页")
      true
    } catch (e: Exception) {
      Log.w(TAG, "打开 HC 设置页也失败", e)
      false
    }

  /** 读 HC 的全部运动会话（含配对出的消耗/距离/心率），写 pull.json */
  @JvmStatic
  fun startRead(context: Context) {
    val app = context.applicationContext
    scope.launch {
      try {
        val client = clientOrNull(app) ?: return@launch fail(app, "Health Connect 不可用")
        val now = Instant.now()
        val sessions = readAll(client, ExerciseSessionRecord::class, EPOCH, now)

        // 三类附加记录：HC 里它们与运动会话没有外键，只能按时间重叠配对
        val from = sessions.minOfOrNull { it.startTime } ?: now
        val to = sessions.maxOfOrNull { it.endTime } ?: now
        val energy = if (sessions.isEmpty()) emptyList()
        else readAll(client, TotalCaloriesBurnedRecord::class, from, to)
        val distance = if (sessions.isEmpty()) emptyList()
        else readAll(client, DistanceRecord::class, from, to)
        val heart = if (sessions.isEmpty()) emptyList()
        else readAll(client, HeartRateRecord::class, from, to)

        val kcal = assignByOverlap(sessions, energy) { _, r -> r.energy.inKilocalories }
        val meters = assignByOverlap(sessions, distance) { _, r -> r.distance.inMeters }
        val avgHr = averageHeartRate(sessions, heart)

        val records = JSONArray()
        sessions.forEachIndexed { index, s ->
          val offset = s.startZoneOffset ?: ZoneOffset.UTC
          val obj = JSONObject()
          obj.put("id", s.metadata.id)
          obj.put("exerciseType", s.exerciseType)
          obj.put("title", s.title ?: JSONObject.NULL)
          obj.put("notes", s.notes ?: JSONObject.NULL)
          obj.put("startEpochMs", s.startTime.toEpochMilli())
          obj.put("endEpochMs", s.endTime.toEpochMilli())
          obj.put("utcOffsetSeconds", offset.totalSeconds)
          obj.put("lastModifiedEpochMs", s.metadata.lastModifiedTime.toEpochMilli())
          obj.put("dataOrigin", s.metadata.dataOrigin.packageName)
          obj.put("kcal", kcal[index] ?: JSONObject.NULL)
          obj.put("distanceM", meters[index] ?: JSONObject.NULL)
          obj.put("avgHeartRate", avgHr[index] ?: JSONObject.NULL)
          records.put(obj)
        }
        writeFile(app, PULL_FILE, JSONObject().put("records", records).toString())
        writeState(app)
      } catch (e: Exception) {
        Log.e(TAG, "读取健康数据失败", e)
        fail(app, "读取健康数据失败：${e.message}")
      }
    }
  }

  /**
   * 把 push-request.json 里的记录写进 HC。
   *
   * 幂等靠 `clientRecordId`：先读出「本 App 写过的」记录，凡 clientRecordId 已在的
   * 先删再插（改一条已导出记录 = 重写）。这样即使上一次写到一半被杀，
   * 下一次也不会在 HC 里留下两条同样的记录。
   *
   * **签名必须是无参的**（除 Context 外）：Rust 按文件位置约定（cacheDir 下的
   * 固定文件名）把要写的内容先落盘，JNI 只需要喊一声「开始写」。这里要是一个
   * 带 path 的签名，Rust 的无参 JNI 调用就会 NoSuchMethodError —— 而且它被
   * 异常兜底吞掉之后，前端只会看到「超时」，极难排查（实测过一次）。
   */
  @JvmStatic
  fun startWrite(context: Context) {
    val app = context.applicationContext
    scope.launch {
      try {
        val client = clientOrNull(app) ?: return@launch fail(app, "Health Connect 不可用")
        val requestFile = File(File(app.cacheDir, DIR), PUSH_REQUEST_FILE)
        val request = JSONObject(requestFile.readText())
        val drafts = request.getJSONArray("records")
        if (drafts.length() == 0) {
          writeFile(app, PUSH_RESULT_FILE, JSONObject().put("results", JSONArray()).toString())
          writeState(app)
          return@launch
        }

        val own = readAll(
          client,
          ExerciseSessionRecord::class,
          EPOCH,
          Instant.now(),
          dataOrigin = setOf(DataOrigin(SELF_PACKAGE)),
        )
        val existing = HashMap<String, String>()
        own.forEach { r ->
          val crid = r.metadata.clientRecordId
          if (!crid.isNullOrEmpty()) existing[crid] = r.metadata.id
        }

        val toDelete = mutableListOf<String>()
        drafts.length().let { n ->
          for (i in 0 until n) {
            existing[drafts.getJSONObject(i).getString("clientRecordId")]?.let { toDelete.add(it) }
          }
        }
        if (toDelete.isNotEmpty()) {
          client.deleteRecords(ExerciseSessionRecord::class, toDelete, emptyList())
        }

        val zone = ZoneId.systemDefault()
        val records = mutableListOf<ExerciseSessionRecord>()
        for (i in 0 until drafts.length()) {
          val d = drafts.getJSONObject(i)
          val start = Instant.ofEpochMilli(d.getLong("startEpochMs"))
          val end = Instant.ofEpochMilli(d.getLong("endEpochMs"))
          records.add(
            ExerciseSessionRecord(
              startTime = start,
              startZoneOffset = zone.rules.getOffset(start),
              endTime = end,
              endZoneOffset = zone.rules.getOffset(end),
              metadata = Metadata.manualEntryWithId(d.getString("clientRecordId")),
              exerciseType = d.getInt("exerciseType"),
              title = if (d.isNull("title")) null else d.getString("title"),
              notes = if (d.isNull("notes")) null else d.getString("notes"),
            )
          )
        }

        val response = client.insertRecords(records)
        val results = JSONArray()
        response.recordIdsList.forEachIndexed { i, recordId ->
          results.put(
            JSONObject()
              .put("clientRecordId", drafts.getJSONObject(i).getString("clientRecordId"))
              .put("recordId", recordId)
          )
        }
        writeFile(app, PUSH_RESULT_FILE, JSONObject().put("results", results).toString())
        writeState(app)
      } catch (e: Exception) {
        Log.e(TAG, "写入健康数据失败", e)
        fail(app, "写入健康数据失败：${e.message}")
      }
    }
  }

  /** 删掉一条 Rein 写出去的记录（用户在 Rein 里删了那条运动记录） */
  @JvmStatic
  fun deleteRecord(context: Context, recordId: String) {
    val app = context.applicationContext
    scope.launch {
      try {
        val client = clientOrNull(app) ?: return@launch
        client.deleteRecords(ExerciseSessionRecord::class, listOf(recordId), emptyList())
      } catch (e: Exception) {
        // 删不掉不阻塞用户：本地已经删了，这里只记日志（下次同步还会断链重试）
        Log.w(TAG, "删除 HC 记录失败：$recordId", e)
      }
    }
  }

  /* ---------------- 内部 ---------------- */

  private fun clientOrNull(context: Context): HealthConnectClient? {
    val status = HealthConnectClient.getSdkStatus(context)
    if (status != HealthConnectClient.SDK_AVAILABLE) return null
    return try {
      HealthConnectClient.getOrCreate(context)
    } catch (e: Exception) {
      Log.e(TAG, "获取 HealthConnectClient 失败", e)
      null
    }
  }

  /** 失败路径：只写 state.json 的 error，**不写结果文件**（Rust 据此立刻收场） */
  private suspend fun fail(context: Context, message: String) {
    writeState(context, error = message)
  }

  /** 分页读完一个记录类型的全部记录（HC 单页上限 1000 条） */
  private suspend fun <T : Record> readAll(
    client: HealthConnectClient,
    recordType: KClass<T>,
    from: Instant,
    to: Instant,
    dataOrigin: Set<DataOrigin> = emptySet(),
  ): List<T> {
    val out = mutableListOf<T>()
    var token: String? = null
    do {
      val response =
        client.readRecords(
          ReadRecordsRequest(
            recordType,
            TimeRangeFilter.between(from, to),
            dataOriginFilter = dataOrigin,
            pageToken = token,
          )
        )
      out.addAll(response.records)
      token = response.pageToken
    } while (token != null)
    return out
  }

  /**
   * 按「与哪个会话重叠最多」把附加记录配给会话。
   *
   * 为什么不做按比例分摊：HC 里一条消耗记录通常就是一个会话写的一条，
   * 重叠最多的那个会话几乎总是它的主人；分摊只会引入一个更复杂、
   * 也更难解释的数字，而单位换算本身已经带了足够的误差。
   */
  private fun <T : Record> assignByOverlap(
    sessions: List<ExerciseSessionRecord>,
    records: List<T>,
    value: (Int, T) -> Double,
  ): List<Double?> {
    val sums = arrayOfNulls<Double>(sessions.size)
    records.forEach { r ->
      val (rs, re) = intervalOf(r) ?: return@forEach
      var best = -1
      var bestOverlap = 0L
      sessions.forEachIndexed { i, s ->
        val overlap = minOf(re, s.endTime.toEpochMilli()) - maxOf(rs, s.startTime.toEpochMilli())
        if (overlap > bestOverlap) {
          bestOverlap = overlap
          best = i
        }
      }
      if (best >= 0) sums[best] = (sums[best] ?: 0.0) + value(best, r)
    }
    return sums.toList()
  }

  /**
   * 会话内的平均心率：把样本按「落在哪个会话里」归组再平均。
   * 样本本来就是密集的时序点，按重叠配给会话反而会把间隙算进去。
   */
  private fun averageHeartRate(
    sessions: List<ExerciseSessionRecord>,
    records: List<HeartRateRecord>,
  ): List<Double?> {
    val sum = DoubleArray(sessions.size)
    val count = IntArray(sessions.size)
    records.forEach { r ->
      r.samples.forEach { sample ->
        val t = sample.time.toEpochMilli()
        val i = sessions.indexOfFirst { t >= it.startTime.toEpochMilli() && t <= it.endTime.toEpochMilli() }
        if (i >= 0) {
          sum[i] += sample.beatsPerMinute.toDouble()
          count[i] += 1
        }
      }
    }
    return sessions.indices.map { if (count[it] > 0) sum[it] / count[it] else null }
  }

  /** 取一个区间记录的起止（毫秒）；认不出来的类型返回 null */
  private fun intervalOf(record: Record): Pair<Long, Long>? =
    when (record) {
      is TotalCaloriesBurnedRecord ->
        record.startTime.toEpochMilli() to record.endTime.toEpochMilli()
      is DistanceRecord -> record.startTime.toEpochMilli() to record.endTime.toEpochMilli()
      is HeartRateRecord -> record.startTime.toEpochMilli() to record.endTime.toEpochMilli()
      else -> null
    }

  private suspend fun writeState(context: Context, error: String? = null) {
    val availability =
      when (HealthConnectClient.getSdkStatus(context)) {
        HealthConnectClient.SDK_AVAILABLE -> "available"
        HealthConnectClient.SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED -> "update_required"
        else -> "unavailable"
      }
    var readGranted = false
    var writeGranted = false
    if (availability == "available") {
      try {
        val granted =
          HealthConnectClient.getOrCreate(context).permissionController.getGrantedPermissions()
        readGranted = granted.containsAll(READ_PERMS)
        writeGranted = granted.containsAll(WRITE_PERMS)
      } catch (e: Exception) {
        Log.w(TAG, "读取授权状态失败", e)
      }
    }
    val obj =
      JSONObject()
        .put("availability", availability)
        .put("readGranted", readGranted)
        .put("writeGranted", writeGranted)
        .put("error", error ?: JSONObject.NULL)
    writeFile(context, STATE_FILE, obj.toString())
  }

  private fun writeFile(context: Context, name: String, text: String) {
    try {
      val dir = File(context.cacheDir, DIR)
      dir.mkdirs()
      val target = File(dir, name)
      // 先写 .part 再改名：Rust 用「文件存在」判断本轮完成，
      // 半截文件被读到会当成一次成功的解析失败（json 解析失败 → 被当成还没准备好）
      val part = File(dir, "$name.part")
      part.writeText(text)
      if (!part.renameTo(target)) {
        part.delete()
        Log.e(TAG, "改名失败：$part -> $target")
      }
    } catch (e: Exception) {
      Log.e(TAG, "写 $name 失败", e)
    }
  }
}
