"""Coverage selection must reject disconnected or malformed road requests."""
import unittest
import road_host

class RegionsTests(unittest.TestCase):
    def setUp(self):
        self.regions=[dict(id='a',bbox=[29,-96,30,-95]),dict(id='b',bbox=[33,-85,34,-84])]

    def test_all_matrix_points_must_share_region(self):
        req=dict(sources=[dict(lat=29.5,lon=-95.5)],targets=[dict(lat=33.5,lon=-84.5)])
        with self.assertRaisesRegex(ValueError,'ROAD_OUTSIDE_COVERAGE'):road_host.select_region(self.regions,req)

    def test_route_with_closed_return_selects_exact_graph(self):
        req=dict(locations=[dict(lat=29.5,lon=-95.5),dict(lat=29.6,lon=-95.4),dict(lat=29.5,lon=-95.5)])
        self.assertEqual(road_host.select_region(self.regions,req)['id'],'a')

    def test_outside_or_invalid_coordinates_never_fallback(self):
        for loc in [dict(lat=0,lon=0),dict(lat=True,lon=-95.5),dict(lat=float('nan'),lon=-95.5)]:
            with self.assertRaises(ValueError):road_host.select_region(self.regions,dict(locations=[loc]))

if __name__=='__main__':unittest.main()
