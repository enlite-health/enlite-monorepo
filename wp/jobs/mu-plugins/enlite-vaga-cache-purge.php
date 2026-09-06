<?php
/**
 * Plugin Name: EnLite — Purga do Breeze quando uma vaga muda de verdade
 * Description: O sync do filtro-avancado-vacantes (WP-Cron, 5 min) reescreve os posts de vaga a cada ciclo,
 *   mas a página pública (/es/) é servida pelo page-cache do Breeze (TTL 24 h) que ninguém purga — uma
 *   descrição editada na plataforma levava até um dia para aparecer no portal (2026-08-26a#PEND-08).
 *   Este mu-plugin escuta MUDANÇA REAL (meta de vaga que mudou de valor, transição de status, remoção)
 *   e purga o cache inteiro uma vez por request, no shutdown. save_post não serve: dispara nos 187 posts
 *   a cada 5 min mesmo sem mudança. Decisão: D219 (ebrain). Fonte versionada: repos/infra/wp/jobs/.
 * Author: Gabriel + Claude
 * Version: 1.0.0
 *
 * Modo: ENLITE_VAGA_PURGE_MODE = 'log' (só conta) | 'purge' (conta e purga). Nasce em 'log' para provar,
 *   por 3 ciclos de cron sem edição, que o contador fica em 0 (a viga do desenho é que update_post_meta
 *   não dispara hook quando o valor é idêntico). Só depois vira 'purge'.
 * Observar: GET /wp-json/enlite/v1/vaga-purge-stats (Application Password, manage_options).
 * Reversível: apagar este arquivo.
 */

if ( ! defined( 'ABSPATH' ) ) { exit; }

if ( ! defined( 'ENLITE_VAGA_PURGE_MODE' ) ) {
	define( 'ENLITE_VAGA_PURGE_MODE', 'log' );
}

if ( ! class_exists( 'Enlite_Vaga_Cache_Purge' ) ) {

final class Enlite_Vaga_Cache_Purge {
	const OPTION  = 'enlite_vaga_purge_stats';
	const VERSION = '1.0.0';

	/** @var bool algo de vaga mudou neste request */
	private static $dirty = false;
	/** @var array<string,int> motivo => quantas vezes neste request */
	private static $reasons = array();

	public static function boot() {
		add_action( 'updated_post_meta', array( __CLASS__, 'on_meta' ), 10, 4 );
		add_action( 'added_post_meta', array( __CLASS__, 'on_meta' ), 10, 4 );
		add_action( 'deleted_post_meta', array( __CLASS__, 'on_meta' ), 10, 4 );
		add_action( 'transition_post_status', array( __CLASS__, 'on_transition' ), 10, 3 );
		add_action( 'deleted_post', array( __CLASS__, 'on_deleted' ), 10, 2 );
		add_action( 'shutdown', array( __CLASS__, 'on_shutdown' ), 1 );
		add_action( 'rest_api_init', array( __CLASS__, 'register_rest' ) );
	}

	/** Post de vaga? (vagas_ar / vagas_br / vagas_en) */
	public static function is_vaga( $post_id ) {
		$type = get_post_type( (int) $post_id );
		return is_string( $type ) && strpos( $type, 'vagas_' ) === 0;
	}

	/** meta_id, object_id, meta_key, meta_value — hooks de meta do core */
	public static function on_meta( $meta_id, $object_id, $meta_key, $meta_value = null ) {
		try {
			if ( ! is_string( $meta_key ) || $meta_key === '' || $meta_key[0] === '_' ) {
				return; // _edit_lock, _edit_last, _thumbnail_id…: ruído de admin, não conteúdo
			}
			if ( ! self::is_vaga( $object_id ) ) {
				return;
			}
			self::mark( 'meta:' . $meta_key );
		} catch ( \Throwable $e ) {
			// nunca derrubar o request por causa de cache
		}
	}

	public static function on_transition( $new_status, $old_status, $post ) {
		try {
			if ( $new_status === $old_status ) {
				return; // wp_update_post do sync: publish → publish, não é mudança
			}
			$post_id = is_object( $post ) ? (int) $post->ID : (int) $post;
			if ( ! self::is_vaga( $post_id ) ) {
				return;
			}
			self::mark( 'status:' . $old_status . '>' . $new_status );
		} catch ( \Throwable $e ) {
		}
	}

	public static function on_deleted( $post_id, $post = null ) {
		try {
			$type = is_object( $post ) && isset( $post->post_type ) ? $post->post_type : get_post_type( (int) $post_id );
			if ( is_string( $type ) && strpos( $type, 'vagas_' ) === 0 ) {
				self::mark( 'deleted' );
			}
		} catch ( \Throwable $e ) {
		}
	}

	private static function mark( $reason ) {
		self::$dirty = true;
		if ( ! isset( self::$reasons[ $reason ] ) ) {
			self::$reasons[ $reason ] = 0;
		}
		self::$reasons[ $reason ]++;
	}

	/** Uma purga por request, no fim — 187 metas mudadas num ciclo viram UM flush. */
	public static function on_shutdown() {
		if ( ! self::$dirty ) {
			return;
		}
		try {
			$stats = get_option( self::OPTION, array() );
			if ( ! is_array( $stats ) ) {
				$stats = array();
			}
			$stats['count']        = (int) ( $stats['count'] ?? 0 ) + 1;
			$stats['last_at']      = gmdate( 'c' );
			$stats['last_mode']    = ENLITE_VAGA_PURGE_MODE;
			$stats['last_reasons'] = self::$reasons;
			$stats['version']      = self::VERSION;
			update_option( self::OPTION, $stats, false );

			if ( ENLITE_VAGA_PURGE_MODE === 'purge' ) {
				self::purge();
				$stats['last_purged_at'] = gmdate( 'c' );
				update_option( self::OPTION, $stats, false );
			}
		} catch ( \Throwable $e ) {
		}
		self::$dirty   = false;
		self::$reasons = array();
	}

	/** Cinto e suspensório: a ação global do Breeze + o flush direto da pasta de cache (purge-cache.php:763). */
	public static function purge() {
		do_action( 'breeze_clear_all_cache' );
		if ( class_exists( 'Breeze_PurgeCache' ) && method_exists( 'Breeze_PurgeCache', 'breeze_cache_flush' ) ) {
			Breeze_PurgeCache::breeze_cache_flush( true, true, true );
		}
	}

	public static function register_rest() {
		register_rest_route( 'enlite/v1', '/vaga-purge-stats', array(
			'methods'             => 'GET',
			'permission_callback' => function () { return current_user_can( 'manage_options' ); },
			'callback'            => function () {
				$stats = get_option( self::OPTION, array() );
				return array(
					'mode'    => ENLITE_VAGA_PURGE_MODE,
					'version' => self::VERSION,
					'stats'   => is_array( $stats ) ? $stats : array(),
				);
			},
		) );
	}
}

Enlite_Vaga_Cache_Purge::boot();

}
