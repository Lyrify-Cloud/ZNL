slave id: slave-check
root path: D:\Github Desktop\Lyrify Cloud\ZNL\test\slave\data\slave-check

这个目录被暴露给 master.fs 进行远程管理。
你可以在 master 侧执行：
  fs ls
  fs cat README.txt
  fs upload <local> <remote>
  fs download <remote> <local>
  fs mv <from> <to>
  fs rm <path>
