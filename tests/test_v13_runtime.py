import unittest, sys, json, subprocess, os
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import server, road_service, core
from unittest.mock import patch
class VersionAndRoad(unittest.TestCase):
 def test_binding(self):
  self.assertEqual(server.APP_VERSION,'v13')
  self.assertEqual(Path(core.__file__).parent.parent.name,'v13')
  self.assertEqual(server.STATIC.name,'v13')
 def test_null_never_zero(self):
  with self.assertRaises(core.ApiError): road_service.matrix({'sources_to_targets':[[{'time':None}]]},1)
 def test_return_is_inside_shift(self):
  jobs=[{'id':1,'time_windows':[[0,1000]],'service':60}]
  vehicle={'time_window':[0,200],'end_index':0}
  with self.assertRaises(core.ApiError): road_service.validate_sequence([1],jobs,[[0,50],[100,0]],vehicle)
 def test_fixed_order_window(self):
  jobs=[{'id':1,'time_windows':[[0,20]],'service':10}]
  with self.assertRaises(core.ApiError): road_service.validate_sequence([1],jobs,[[0,30],[30,0]],{'time_window':[0,500]})
 def test_cache_direction_truck_version(self):
  road_service.MATRIX_CACHE.clear()
  reply={'sources_to_targets':[[{'time':0},{'time':30}],[{'time':70},{'time':0}]]}
  with patch.object(road_service,'post',return_value=reply) as post:
   args=({'costing':'truck','height':3.2},[{'lat':32,'lon':-96},{'lat':33,'lon':-97}],{'warehouse':1},0)
   first,hit=road_service.cached_matrix(*args);self.assertFalse(hit)
   second,hit=road_service.cached_matrix(*args);self.assertTrue(hit)
   self.assertEqual(road_service.matrix(second,2),[[0,30],[70,0]])
   road_service.cached_matrix(args[0],args[1],{'warehouse':2},0)
   road_service.cached_matrix({'costing':'truck','height':4.2},*args[1:])
   self.assertEqual(post.call_count,3)
if __name__=='__main__':unittest.main()
