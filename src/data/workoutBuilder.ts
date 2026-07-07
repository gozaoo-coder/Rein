import {
  StepType,
  MediaType,
  type TimerUnit,
  type WorkoutStep,
  type WorkoutPlan,
  type Guide,
  type StepDetails,
  type TimerConfig,
} from "@/types/workout";

class StepBuilder {
  private _step: Partial<WorkoutStep> = {};
  private parent: WorkoutBuilder;

  constructor(parent: WorkoutBuilder, type: StepType) {
    this.parent = parent;
    this._step.type = type;
    if (type === StepType.RESTING) {
      this._step.timer = { enabled: true, unit: "seconds", value: 60 };
      this._step.phase = "Rest";
    } else {
      this._step.timer = { enabled: false, unit: "seconds", value: 0 };
      this._step.phase = "Normal";
    }
    this._step.details = { title: "", guide: { type: MediaType.MARKDOWN_TEXT, content: "" } };
  }

  setPhase(text: string): this {
    this._step.phase = text;
    return this;
  }

  setTimer(enabled: boolean, unit: TimerUnit, value: number): this {
    this._step.timer = { enabled, unit, value };
    return this;
  }

  setSeconds(seconds: number): this {
    this._step.timer = { enabled: true, unit: "seconds", value: seconds };
    return this;
  }

  setReps(reps: number): this {
    this._step.timer = { enabled: false, unit: "reps", value: reps };
    return this;
  }

  setTitle(title: string): this {
    if (this._step.details) {
      this._step.details.title = title;
    }
    return this;
  }

  setGuide(mediaType: MediaType, contentOrUrl: string): this {
    const guide: Guide = { type: mediaType };
    if (mediaType === MediaType.MARKDOWN_TEXT) {
      guide.content = contentOrUrl;
    } else {
      guide.url = contentOrUrl;
    }
    if (this._step.details) {
      this._step.details.guide = guide;
    }
    return this;
  }

  setDetails(title: string, mediaType: MediaType, contentOrUrl: string): this {
    this.setTitle(title);
    this.setGuide(mediaType, contentOrUrl);
    return this;
  }

  done(): WorkoutBuilder {
    const step = this._step as WorkoutStep;
    if (step.type === StepType.RESTING) {
      if (!step.timer?.enabled || step.timer.unit !== "seconds") {
        step.timer = { enabled: true, unit: "seconds", value: step.timer?.value ?? 60 };
      }
    }
    this.parent["pushStep"](step);
    return this.parent;
  }
}

export class WorkoutBuilder {
  private _name = "";
  private _level = "";
  private _steps: WorkoutStep[] = [];

  nameAs(name: string): this {
    this._name = name;
    return this;
  }

  editLevel(level: string): this {
    this._level = level;
    return this;
  }

  addTrainingStep(): StepBuilder {
    return new StepBuilder(this, StepType.TRAINING);
  }

  addRestingStep(seconds: number = 60): StepBuilder {
    const builder = new StepBuilder(this, StepType.RESTING);
    builder.setSeconds(seconds);
    return builder;
  }

  private pushStep(step: WorkoutStep): void {
    this._steps.push(step);
  }

  build(): WorkoutPlan {
    const trainingSteps = this._steps.filter((s) => s.type === StepType.TRAINING);
    const plan: WorkoutPlan = {
      name: this._name,
      level: this._level,
      steps: this._steps,
    };
    (plan as WorkoutPlan & { _trainingSetCount?: number })._trainingSetCount = trainingSteps.length;
    return plan;
  }
}

export function getTrainingSetCount(plan: WorkoutPlan): number {
  return plan.steps.filter((s) => s.type === StepType.TRAINING).length;
}

export function createSampleWorkout(): WorkoutPlan {
  return new WorkoutBuilder()
    .nameAs("入门健身房胸部训练")
    .editLevel("健身新手")

    .addTrainingStep()
      .setPhase("热身")
      .setSeconds(30)
      .setDetails("胸部拉伸", MediaType.MARKDOWN_TEXT, "1. 站立，双脚与肩同宽\n2. 双手交叉置于身后\n3. 缓慢抬起手臂感受胸部拉伸\n4. 保持呼吸均匀")
      .done()

    .addRestingStep(15)
      .setPhase("休息")
      .setTitle("短暂休息")
      .setGuide(MediaType.MARKDOWN_TEXT, "调整呼吸，准备开始正式训练")
      .done()

    .addTrainingStep()
      .setPhase("充血")
      .setReps(12)
      .setDetails("哑铃卧推", MediaType.MARKDOWN_TEXT, "1. 平躺在卧推凳上\n2. 双手握哑铃，掌心朝前\n3. 推起哑铃至手臂伸直\n4. 缓慢下放至胸部两侧\n5. 完成12次")
      .done()

    .addRestingStep(60)
      .setPhase("休息")
      .setTitle("组间休息")
      .setGuide(MediaType.MARKDOWN_TEXT, "深呼吸，补充水分，准备下一组")
      .done()

    .addTrainingStep()
      .setPhase("极限")
      .setReps(10)
      .setDetails("哑铃卧推（加重）", MediaType.MARKDOWN_TEXT, "1. 增加哑铃重量\n2. 保持动作标准\n3. 推起时呼气，下放时吸气\n4. 完成10次，感受胸肌发力")
      .done()

    .addRestingStep(90)
      .setPhase("休息")
      .setTitle("长休息")
      .setGuide(MediaType.MARKDOWN_TEXT, "充分休息，准备最后一组")
      .done()

    .addTrainingStep()
      .setPhase("力量")
      .setReps(8)
      .setDetails("哑铃卧推（极限重量）", MediaType.MARKDOWN_TEXT, "1. 使用极限重量的80%\n2. 注意保护，必要时请人辅助\n3. 专注发力，控制节奏\n4. 完成8次，力竭为止")
      .done()

    .addRestingStep(60)
      .setPhase("休息")
      .setTitle("休息放松")
      .setGuide(MediaType.MARKDOWN_TEXT, "慢慢放下哑铃，甩动手臂放松")
      .done()

    .addTrainingStep()
      .setPhase("拉伸")
      .setSeconds(60)
      .setDetails("胸部放松拉伸", MediaType.MARKDOWN_TEXT, "1. 找一个门框或立柱\n2. 单手扶住，身体前倾\n3. 感受胸部肌肉拉伸\n4. 每侧30秒\n5. 深呼吸，慢慢放松")
      .done()

    .build();
}
