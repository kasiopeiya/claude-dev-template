// 責務: auto-programmer が起動する無人の claude セッションを、中で動くフックと Skill が見分けるための
//   環境変数の名前と値を1か所に持つ。
//
// 設計意図（WHY）:
// - 起動側（claudeSession.mjs）が渡し、対話セッション向けのフック（.claude/hooks/wake-on-ci-failure.mjs）と
//   /auto-fix-ci が読む。JS の読み手はここを import し、名前を書き写さない。
//   /auto-fix-ci の SKILL.md は import できないので、名前と値を書き写している。変えるときは、SKILL.md の
//   printenv の行と「`1` が出れば無人」も直す。直し忘れると、無人の /auto-fix-ci が自分を対話だと判定して、
//   離脱しても needs-human-check もコメントも付けずに終わる。
// - 値は「付いている」ことだけを表す。無人かどうかを、フックや Skill が親プロセスや端末の有無から推測しない。

export const UNATTENDED_SESSION_ENV_NAME = 'AUTO_PROGRAMMER_UNATTENDED_SESSION'
export const UNATTENDED_SESSION_ENV_VALUE = '1'
