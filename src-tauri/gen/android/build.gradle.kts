buildscript {
    repositories {
        // google() 直连在国内网络基本不通（实测 maven.google.com 超时，阿里云镜像正常），
        // 所以镜像放前面先试，google() 留作兜底（换网络/挂代理时仍可用）。
        // 只镜像 Google Maven：Maven Central 直连是通的（repo1.maven.org 0.7s 内响应）。
        maven { url = uri("https://maven.aliyun.com/repository/google") }
        google()
        mavenCentral()
    }
    dependencies {
        classpath("com.android.tools.build:gradle:8.11.0")
        classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:1.9.25")
    }
}

allprojects {
    repositories {
        maven { url = uri("https://maven.aliyun.com/repository/google") }
        google()
        mavenCentral()
    }
}

tasks.register("clean").configure {
    delete("build")
}

