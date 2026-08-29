<?php
/**
 * Harness sem WordPress: stubs mínimos do core para provar a lógica do mu-plugin.
 * Roda: php wp/jobs/tests/enlite-vaga-cache-purge.test.php  → "OK: n/n" (rc 0) ou FALHA (rc 1).
 * O que NÃO prova: que o Breeze purga de verdade (isso só a medição em prod prova — plano, passo 3).
 */
declare(strict_types=1);

// ── stubs do core ──────────────────────────────────────────────────────────────
define( 'ABSPATH', '/stub/' );
$GLOBALS['stub_actions'] = array();
$GLOBALS['stub_types']   = array( 10 => 'vagas_ar', 20 => 'post', 30 => 'vagas_br' );
$GLOBALS['stub_options'] = array();
$GLOBALS['stub_purged']  = 0;
$GLOBALS['stub_rest']    = array();
function add_action( $hook, $cb, $prio = 10, $args = 1 ) { $GLOBALS['stub_actions'][ $hook ][] = $cb; }
function do_action( $hook, ...$a ) {
	if ( $hook === 'breeze_clear_all_cache' ) { $GLOBALS['stub_purged']++; }
	foreach ( $GLOBALS['stub_actions'][ $hook ] ?? array() as $cb ) { call_user_func_array( $cb, $a ); }
}
function get_post_type( $id ) { return $GLOBALS['stub_types'][ (int) $id ] ?? false; }
function get_option( $k, $d = false ) { return $GLOBALS['stub_options'][ $k ] ?? $d; }
function update_option( $k, $v, $autoload = null ) { $GLOBALS['stub_options'][ $k ] = $v; return true; }
function register_rest_route( $ns, $route, $args ) { $GLOBALS['stub_rest'][ $ns . $route ] = $args; }
function current_user_can( $cap ) { return $GLOBALS['stub_can'] ?? false; }
class Breeze_PurgeCache { public static function breeze_cache_flush( $a = true, $b = true, $c = false ) { $GLOBALS['stub_purged'] += 10; } }

$mode = getenv( 'MODE' ) ?: 'log';
define( 'ENLITE_VAGA_PURGE_MODE', $mode );
require __DIR__ . '/../mu-plugins/enlite-vaga-cache-purge.php';

// ── régua ──────────────────────────────────────────────────────────────────────
$ok = 0; $n = 0;
function check( string $nome, bool $cond ) {
	global $ok, $n; $n++;
	if ( $cond ) { $ok++; echo "  ✓ $nome\n"; } else { echo "  ✗ $nome\n"; }
}
function stats() { return $GLOBALS['stub_options'][ Enlite_Vaga_Cache_Purge::OPTION ] ?? array(); }
function request( callable $body ) { $body(); do_action( 'shutdown' ); }

echo "modo=$mode\n";
// 1. meta de vaga muda → 1 contagem por request (mesmo com várias metas)
request( function () { do_action( 'updated_post_meta', 1, 10, 'job_description', 'x' ); do_action( 'updated_post_meta', 2, 10, 'localidad', 'y' ); } );
check( 'meta em vagas_ar conta 1 por request (2 metas → 1)', ( stats()['count'] ?? 0 ) === 1 );
check( 'motivos registrados', isset( stats()['last_reasons']['meta:job_description'], stats()['last_reasons']['meta:localidad'] ) );
// 2. meta em post comum → nada
request( function () { do_action( 'updated_post_meta', 3, 20, 'job_description', 'x' ); } );
check( 'meta em post comum não conta', ( stats()['count'] ?? 0 ) === 1 );
// 3. meta interna _edit_lock em vaga → nada
request( function () { do_action( 'updated_post_meta', 4, 10, '_edit_lock', 'x' ); } );
check( 'meta _edit_lock não conta', ( stats()['count'] ?? 0 ) === 1 );
// 4. request sem evento → nada
request( function () {} );
check( 'request sem evento não conta', ( stats()['count'] ?? 0 ) === 1 );
// 5. transição publish→publish (o wp_update_post do sync) → nada; publish→trash → conta
request( function () { do_action( 'transition_post_status', 'publish', 'publish', (object) array( 'ID' => 10 ) ); } );
check( 'publish→publish não conta', ( stats()['count'] ?? 0 ) === 1 );
request( function () { do_action( 'transition_post_status', 'trash', 'publish', (object) array( 'ID' => 30 ) ); } );
check( 'publish→trash em vagas_br conta', ( stats()['count'] ?? 0 ) === 2 && isset( stats()['last_reasons']['status:publish>trash'] ) );
// 6. deleted_post de vaga conta; de post comum não
request( function () { do_action( 'deleted_post', 10, (object) array( 'post_type' => 'vagas_ar' ) ); } );
check( 'deleted_post de vaga conta', ( stats()['count'] ?? 0 ) === 3 );
request( function () { do_action( 'deleted_post', 20, (object) array( 'post_type' => 'post' ) ); } );
check( 'deleted_post de post comum não conta', ( stats()['count'] ?? 0 ) === 3 );
// 7. purga só em modo purge — e uma vez por request (ação + flush direto = 1 + 10)
$esperado = $mode === 'purge' ? 3 * 11 : 0;
check( "purge chamado " . ( $mode === 'purge' ? '3× (ação+flush)' : '0× em log' ), $GLOBALS['stub_purged'] === $esperado );
check( 'last_mode gravado', ( stats()['last_mode'] ?? '' ) === $mode );
// 8. REST registrado (só em rest_api_init — antes dele, nada) e protegido
check( 'rota REST NÃO registrada antes de rest_api_init', ! isset( $GLOBALS['stub_rest']['enlite/v1/vaga-purge-stats'] ) );
do_action( 'rest_api_init' );
check( 'rota REST registrada', isset( $GLOBALS['stub_rest']['enlite/v1/vaga-purge-stats'] ) );
$GLOBALS['stub_can'] = false; $perm = $GLOBALS['stub_rest']['enlite/v1/vaga-purge-stats']['permission_callback'];
check( 'REST nega sem manage_options', $perm() === false );
$GLOBALS['stub_can'] = true;
check( 'REST permite com manage_options', $perm() === true );
$resp = $GLOBALS['stub_rest']['enlite/v1/vaga-purge-stats']['callback']();
check( 'REST devolve mode + stats', $resp['mode'] === $mode && ( $resp['stats']['count'] ?? 0 ) === 3 );

echo ( $ok === $n ? "OK" : "FALHA" ) . ": $ok/$n\n";
exit( $ok === $n ? 0 : 1 );
