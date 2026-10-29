# CMake toolchain file for the native code built from source on Windows (llama.cpp): the static
# CRT (/MT), as the rest of the app. Its CMake policies leave the runtime to this
# setting, overriding the /MT flag cmake-rs passes for LLAMA_STATIC_CRT. Set in .cargo/config.toml.
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
